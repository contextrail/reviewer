import { generateText, tool } from 'ai';
import { CitationError, EvidenceLedger } from '../src/evidence.js';
import { digest } from '../src/prepare.js';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    Diagnostics,
    sanitizeRecord,
    submissionDiagnostics,
    submissionToolDiagnostics,
    type LogLevel,
} from '../src/diagnostics.js';
const dirs: string[] = [];
afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('safe diagnostics independent of console level', () => {
    it.each(['quiet', 'info', 'debug'] as LogLevel[])(
        '%s always retains safe correlated events without request or source bodies',
        async (level) => {
            const dir = mkdtempSync(join(tmpdir(), 'governed-diag-'));
            dirs.push(dir);
            vi.stubEnv('OPENROUTER_API_KEY', 'SENSITIVE_KEY_12345');
            const log = vi.fn(),
                diagnostics = new Diagnostics(dir, 'run-id', level, log);
            await diagnostics.event('phase_started', {
                phase: 'assess',
                workUnitId: 'unit1',
                attempt: 1,
                hash: 'sha256:abc',
                body: 'RAW_PROMPT',
                source: 'SOURCE_QUOTE',
                response: 'RAW_RESPONSE',
                usage: { cost: 0.01, raw: { prompt: 'RAW_PROMPT' } },
                model: 'SENSITIVE_KEY_12345',
            });
            await diagnostics.event('provider_completed', {
                phase: 'assess',
                workUnitId: 'unit1',
                attempt: 1,
                call: 1,
                status: 200,
            });
            await diagnostics.flush();
            const text = readFileSync(join(dir, 'diagnostics.jsonl'), 'utf8');
            expect(text.trim().split('\n')).toHaveLength(2);
            expect(text).toContain('provider_completed');
            expect(text).toContain('unit1');
            expect(text).not.toMatch(/RAW_PROMPT|SOURCE_QUOTE|RAW_RESPONSE|SENSITIVE_KEY_12345/);
            expect(log.mock.calls.length).toBe(level === 'quiet' ? 0 : level === 'info' ? 1 : 2);
        },
    );
});

it('redacts runtime credentials before JSON escaping, including nested values and keys', () => {
    const secret = 'escaped"\\secret-value';
    vi.stubEnv('CUSTOM_API_KEY', secret);
    const result = sanitizeRecord({ text: `prefix ${secret} suffix`, nested: [secret], [secret]: secret });
    expect(result.text).toBe('prefix [REDACTED] suffix');
    expect(result.nested).toEqual(['[REDACTED]']);
    expect(Object.keys(result)).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(secret).slice(1, -1));
});
it('quiet mode still prints safe fatal failure categories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'governed-failure-'));
    dirs.push(dir);
    const log = vi.fn(),
        diagnostics = new Diagnostics(dir, 'run-id', 'quiet', log);
    await diagnostics.event('phase_failed', { phase: 'verify', code: 'provider_error', body: 'PRIVATE_RESPONSE' });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain('provider_error');
    expect(log.mock.calls[0]![0]).not.toContain('PRIVATE_RESPONSE');
});

it('retains finite validator reasons and schema paths without rejected field names or messages', () => {
    expect(submissionDiagnostics(new Error('check_source_evidence_required')).code).toBe(
        'check_source_evidence_required',
    );
    const detail = submissionDiagnostics({
        issues: [{ code: 'invalid_type', path: ['entries', 0, 'PRIVATE_FIELD_NAME'], message: 'PRIVATE_PROMPT' }],
    });
    expect(detail).toEqual({
        code: 'phase_shape_invalid',
        details: { validation: [{ code: 'invalid_type', path: ['entries', 0, '[field]'] }] },
    });
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE/);
    expect(submissionDiagnostics(new Error('PRIVATE_SOURCE_TEXT')).code).toBe('phase_validation_failed');
});

it.each([
    [
        'citations.0: Unknown evidence ref. Copy a ref returned with pinned guidance or a source read.',
        'citation_unknown',
    ],
    [
        'citations.12: Quote absent from that evidence. Copy exact text, preserving whitespace, or read the relevant source range.',
        'citation_absent',
    ],
    [
        'citations.3: Quote ambiguous in that evidence. Include more surrounding text or read a narrower range.',
        'citation_ambiguous',
    ],
    ['Duplicate/stale update. To explicitly correct this entry, set revisionOf to null.', 'result_revision_invalid'],
    [
        'A supported unmet criterion needs adherence 0 or 1; satisfied permitted alternatives use 2 and finding none.',
        'result_finding_score_inconsistent',
    ],
    [
        'Unresolved/nonapplicable judgments have null adherence and no proven finding; unresolved confidence is null.',
        'result_disposition_score_inconsistent',
    ],
])('categorizes package validator failure without retaining its message: %s', (message, code) => {
    expect(submissionDiagnostics(new Error(message))).toMatchObject({ code });
});
it('recovers safe known schema paths from nested SDK input validation errors', () => {
    const error = {
        name: 'AI_InvalidToolInputError',
        cause: {
            name: 'AI_TypeValidationError',
            cause: {
                issues: [
                    { code: 'invalid_type', path: ['assessments', 0, 'result', 'adherence'], input: 'PRIVATE_SOURCE' },
                ],
            },
        },
    };
    expect(submissionDiagnostics(error)).toEqual({
        code: 'phase_shape_invalid',
        details: {
            validation: [{ code: 'invalid_type', path: ['assessments', 0, 'result', 'adherence'] }],
            causes: ['AI_InvalidToolInputError', 'AI_TypeValidationError'],
        },
    });
});

it('classifies nested SDK JSON parse failures without retaining tool input or exception messages', () => {
    const diagnostic = submissionDiagnostics({
        name: 'AI_InvalidToolInputError',
        message: 'PRIVATE_INPUT',
        toolInput: 'PRIVATE_INPUT',
        cause: {
            name: 'AI_JSONParseError',
            text: 'PRIVATE_PROMPT',
            cause: { name: 'SyntaxError', message: 'PRIVATE_SOURCE' },
        },
    });
    expect(diagnostic).toEqual({
        code: 'phase_json_invalid',
        details: { validation: [], causes: ['AI_InvalidToolInputError', 'AI_JSONParseError', 'SyntaxError'] },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE/);
});

it.each(['schema', 'unknown_tool'] as const)(
    'recovers %s diagnostics from actual SDK tool-error string without copying rejected input',
    async (mode) => {
        let captured: ReturnType<typeof submissionToolDiagnostics> | undefined;
        let stepErrorWasString = false;
        const model = createOpenAI({
            apiKey: 'fixture-key',
            baseURL: 'https://openrouter.ai/api/v1',
            name: 'openrouter',
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        id: 'fixture',
                        object: 'chat.completion',
                        created: 1,
                        model: 'fixture-model',
                        choices: [
                            {
                                index: 0,
                                message: {
                                    role: 'assistant',
                                    content: null,
                                    tool_calls: [
                                        {
                                            id: 'tool-1',
                                            type: 'function',
                                            function: {
                                                name:
                                                    mode === 'schema'
                                                        ? 'submit_assessments'
                                                        : 'submit_unknown_private_name',
                                                arguments: JSON.stringify({ adherence: 'PRIVATE_REJECTED_SOURCE' }),
                                            },
                                        },
                                    ],
                                },
                                finish_reason: 'tool_calls',
                            },
                        ],
                        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
                    }),
                    { headers: { 'content-type': 'application/json' } },
                ),
        }).chat('fixture-model');
        await generateText({
            model,
            tools: {
                submit_assessments: tool({
                    inputSchema: z.strictObject({ adherence: z.number() }),
                    execute: () => ({ accepted: true }),
                }),
            },
            prompt: 'Synthetic tool-shape fixture.',
            maxRetries: 0,
            stopWhen: () => true,
            onStepEnd: (step) => {
                const error = step.content.find((part) => part.type === 'tool-error');
                if (!error || error.type !== 'tool-error') throw new Error('Expected SDK tool-error');
                stepErrorWasString = typeof error.error === 'string';
                captured = submissionToolDiagnostics(error, step.toolCalls);
            },
        });
        expect(stepErrorWasString).toBe(true);
        expect(captured?.code).toBe(mode === 'schema' ? 'phase_shape_invalid' : 'phase_tool_unknown');
        if (mode === 'schema')
            expect(captured?.details.validation).toEqual(
                expect.arrayContaining([{ code: 'invalid_type', path: ['adherence'] }]),
            );
        expect(JSON.stringify(captured)).not.toMatch(/PRIVATE_REJECTED_SOURCE|submit_unknown_private_name|fixture-key/);
    },
);

describe('content-free typed citation diagnostics', () => {
    it('identifies an absent quote by known evidence ref and full schema path without quote content', () => {
        const ledger = new EvidenceLedger(),
            record = ledger.add('PRIVATE_EVIDENCE_BODY', { kind: 'source' });
        const path = ['assessments', 2, 'checks', 1, 'sourceRefs', 0];
        let caught: unknown;
        try {
            ledger.cite({ ref: record.ref, quote: 'PRIVATE_REJECTED_QUOTE' }, path);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CitationError);
        const diagnostic = submissionDiagnostics(caught);
        expect(diagnostic).toEqual({
            code: 'citation_absent',
            details: { validation: [], citation: { path, ref: record.ref, refHash: digest(record.ref) } },
        });
        expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_EVIDENCE_BODY|PRIVATE_REJECTED_QUOTE/);
    });
    it('hashes an unknown malicious ref without echoing its content', () => {
        const ref = 'PRIVATE_REF @here <script>\n' + 'source'.repeat(50),
            ledger = new EvidenceLedger();
        let caught: unknown;
        try {
            ledger.cite({ ref, quote: 'PRIVATE_QUOTE' }, ['assessments', 0, 'findings', 1, 'locationRefs', 2]);
        } catch (error) {
            caught = error;
        }
        const diagnostic = submissionDiagnostics(caught);
        expect(diagnostic).toMatchObject({
            code: 'citation_unknown',
            details: {
                citation: {
                    path: ['assessments', 0, 'findings', 1, 'locationRefs', 2],
                    ref: null,
                    refHash: digest(ref),
                },
            },
        });
        expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|@here|script|source/);
    });
    it('keeps ambiguous citation identity without source or quoted text', () => {
        const ledger = new EvidenceLedger(),
            record = ledger.add('PRIVATE_REPEAT PRIVATE_REPEAT', { kind: 'source' });
        let caught: unknown;
        try {
            ledger.cite({ ref: record.ref, quote: 'PRIVATE_REPEAT' }, ['entries', 0, 'citations', 1]);
        } catch (error) {
            caught = error;
        }
        expect(submissionDiagnostics(caught)).toEqual({
            code: 'citation_ambiguous',
            details: {
                validation: [],
                citation: { path: ['entries', 0, 'citations', 1], ref: record.ref, refHash: digest(record.ref) },
            },
        });
        expect(JSON.stringify(submissionDiagnostics(caught))).not.toContain('PRIVATE_REPEAT');
    });
    it('does not execute subclass getters or trust overwritten citation properties', () => {
        class UntrustedCitationError extends CitationError {}
        const error = new UntrustedCitationError('citation_absent', 'evidence:' + 'a'.repeat(64));
        const getter = vi.fn(() => {
            throw new Error('PRIVATE_GETTER');
        });
        Object.defineProperty(error, 'message', { get: getter });
        Object.defineProperty(error, 'ref', { get: getter });
        Object.defineProperty(error, 'refHash', { value: 'PRIVATE_HASH' });
        Object.defineProperty(error, 'code', { value: 'PRIVATE_CODE' });
        Object.defineProperty(error, 'path', {
            value: [
                'assessments',
                0,
                'PRIVATE_FIELD',
                -1,
                Number.MAX_SAFE_INTEGER + 1,
                ...Array(30).fill('locationRefs'),
            ],
        });
        const result = submissionDiagnostics(error);
        expect(result.code).toBe('phase_validation_failed');
        expect(result.details.citation?.path).toHaveLength(16);
        expect(result.details.citation).toMatchObject({
            ref: null,
            refHash: null,
            path: ['assessments', 0, '[field]', '[field]', '[field]', ...Array(11).fill('locationRefs')],
        });
        expect(getter).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
        expect(submissionDiagnostics({ name: 'CitationError', code: 'citation_absent', ref: 'PRIVATE_REF' })).toEqual({
            code: 'phase_validation_failed',
            details: { validation: [] },
        });
    });
    it('retains only bounded citation metadata in routine logger output', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'citation-diag-'));
        dirs.push(dir);
        const log = vi.fn(),
            diagnostics = new Diagnostics(dir, 'run-id', 'debug', log);
        const ref = 'evidence:' + 'b'.repeat(64),
            refHash = digest(ref);
        await diagnostics.event('submission_rejected', {
            code: 'citation_absent',
            details: {
                validation: [],
                citation: {
                    path: ['assessments', 0, 'result', 'citations', 1, 'quote'],
                    ref,
                    refHash,
                    quote: 'PRIVATE_QUOTE',
                    message: 'PRIVATE_MESSAGE',
                },
            },
        });
        await diagnostics.event('submission_rejected', {
            ref: 'PRIVATE_DIRECT_REF',
            refHash: 'PRIVATE_DIRECT_HASH',
            details: {
                citation: {
                    path: ['findings', 2, 'PRIVATE_PATH', -2, ...Array(30).fill('sourceRefs')],
                    ref: 'PRIVATE_REF',
                    refHash: 'PRIVATE_HASH',
                    text: 'PRIVATE_TEXT',
                },
            },
        });
        await diagnostics.flush();
        const text = readFileSync(join(dir, 'diagnostics.jsonl'), 'utf8'),
            events = text
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
        expect(events[0].data.details.citation).toEqual({
            path: ['assessments', 0, 'result', 'citations', 1, 'quote'],
            ref,
            refHash,
        });
        expect(events[1].data).toMatchObject({
            ref: null,
            refHash: null,
            details: { citation: { ref: null, refHash: null } },
        });
        expect(events[1].data.details.citation.path).toHaveLength(16);
        expect(text).not.toMatch(/PRIVATE|<script>/);
        expect(log).toHaveBeenCalledTimes(2);
    });
});
