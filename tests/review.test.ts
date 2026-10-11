import { McpPublishedReader } from '../src/mcp.js';
import { sendReviewReport } from '../src/feedback.js';
import type { ReviewReportInput } from '../src/report-contract.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prepareReview, digest } from '../src/prepare.js';
import { runReview } from '../src/review.js';
import type { Publication, PublishedReader } from '../src/contracts.js';
import type { ReviewProvider } from '../src/providers.js';

const directories: string[] = [];
afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
let seed: Awaited<ReturnType<typeof createPreparedFixture>> | undefined;
afterAll(() => {
    if (seed) rmSync(seed.state.artifact.repository, { recursive: true, force: true });
});
async function preparedFixture() {
    seed ??= await createPreparedFixture();
    const root = seed.state.artifact.repository;
    const repository = mkdtempSync(join(tmpdir(), 'c3-copy-'));
    directories.push(repository);
    cpSync(root, repository, { recursive: true });
    const prepared = structuredClone(seed);
    prepared.state.artifact.repository = repository;
    prepared.statePath = seed.statePath.replace(root, repository);
    prepared.materialPath = seed.materialPath.replace(root, repository);
    writeFileSync(prepared.statePath, JSON.stringify(prepared.state));
    return prepared;
}
async function createPreparedFixture() {
    const repository = mkdtempSync(join(tmpdir(), 'c3-wire-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(
        join(repository, 'policy.ts'),
        'export function authorize(actor) { if (!actor.allowed) throw new Error("denied"); }\n',
    );
    writeFileSync(join(repository, 'route.ts'), 'export const old = true;\n');
    git('add', '.');
    git('commit', '-qm', 'fixture base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repository, 'route.ts'), 'export function read(actor, document) { return document; }\n');
    git('add', '.');
    git('commit', '-qm', 'fixture change');
    const reviewer: Publication = {
        nodeId: 'skill://engineering/c3',
        version: 1,
        title: 'C3 fixture',
        type: 'skill',
        subtype: 'reviewer',
        domainId: 'engineering',
        status: 'published',
        detailLevel: 'full',
        relationships: [],
        content: {
            kind: 'skill',
            instructions: 'Review both selected contexts.',
            reviewer: { selections: { contextIds: ['context://engineering/a', 'context://engineering/b'] } },
        },
    };
    const contexts: Publication[] = ['a', 'b'].map((id) => ({
        nodeId: `context://engineering/${id}`,
        version: 1,
        title: id,
        type: 'context',
        subtype: 'standard',
        domainId: 'engineering',
        status: 'published',
        detailLevel: 'full',
        relationships: [],
        content: { kind: 'context', body: 'Enforce authorization before disclosure.' },
    }));
    const entries = contexts.map((c) => ({
        nodeId: c.nodeId,
        version: c.version,
        subtype: 'standard',
        reasons: ['selection'],
        contentHash: digest(c.content),
    }));
    const scope = {
        reviewerId: reviewer.nodeId,
        publicationVersion: 1,
        selectionsHash: digest(reviewer.content.reviewer!.selections),
        entries,
        gaps: [],
    };
    const reader: PublishedReader = {
        async read(name, args) {
            return name === 'get_context'
                ? contexts.find((c) => c.nodeId === args.nodeId)
                : args.includeAssessment
                  ? {
                        ...reviewer,
                        assessment: {
                            ...scope,
                            scopeIdentity: digest(scope),
                            complete: true,
                            totalMatched: 2,
                            offset: 0,
                            nextOffset: null,
                        },
                    }
                  : reviewer;
        },
    };
    return prepareReview({ repository, base, head: 'HEAD', reviewerId: reviewer.nodeId, reader });
}
function response(
    provider: ReviewProvider,
    calls: Array<{ name: string; input: unknown }>,
    call: number,
    usage = true,
) {
    const toolCalls = calls.map((c, i) => ({
        id: `call_${call}_${i}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input) },
    }));
    if (provider === 'openrouter')
        return new Response(
            JSON.stringify({
                id: `response_${call}`,
                object: 'chat.completion',
                created: 1,
                model: 'returned-model',
                provider: 'reported-upstream',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: null, tool_calls: toolCalls },
                        finish_reason: 'tool_calls',
                    },
                ],
                ...(usage ? { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 0.001 } } : {}),
            }),
            { headers: { 'content-type': 'application/json' } },
        );
    return new Response(
        JSON.stringify({
            id: `response_${call}`,
            object: 'response',
            created_at: 1,
            status: 'completed',
            model: 'returned-model',
            output: toolCalls.map((c) => ({
                type: 'function_call',
                id: c.id,
                call_id: c.id,
                name: c.function.name,
                arguments: c.function.arguments,
                status: 'completed',
            })),
            ...(usage
                ? {
                      usage: {
                          input_tokens: 12,
                          output_tokens: 8,
                          total_tokens: 20,
                          input_tokens_details: { cached_tokens: 0 },
                          output_tokens_details: { reasoning_tokens: 0 },
                      },
                  }
                : {}),
        }),
        { headers: { 'content-type': 'application/json' } },
    );
}
function submissions(prepared: Awaited<ReturnType<typeof preparedFixture>>) {
    const evidence = JSON.parse(readFileSync(join(dirname(prepared.statePath), 'evidence.json'), 'utf8')) as Record<
        string,
        { ref: string; text: string; provenance: Record<string, unknown> }
    >;
    const records = Object.values(evidence);
    const source = records.find((e) => e.provenance.kind === 'source' && e.provenance.path === 'route.ts')!;
    return prepared.state.entries.map((entry) => {
        const context = records.find(
            (e) => e.provenance.nodeId === entry.nodeId && e.provenance.path === '/content/body',
        )!;
        return {
            assessmentId: entry.assessmentId,
            revisionOf: null,
            disposition: 'evaluated',
            adherence: 0,
            confidence: 3,
            confidenceReason: 'Inspected direct disclosure.',
            finding: 'binding_violation',
            explanation: 'The changed route discloses without a guard.',
            consequence: 'Unauthorized disclosure.',
            correction: 'Restore authorization before return.',
            limitations: ['Inspection only.'],
            citations: [
                { ref: context.ref, quote: context.text },
                { ref: source.ref, quote: source.text },
            ],
        };
    });
}

describe('actual SDK provider wires and source/result tools', () => {
    it.each(['send', 'off', 'rejected', 'network', 'persistence'] as const)(
        'C5 reporting %s preserves finalized judgments, exit and local artifact integrity',
        async (mode) => {
            vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
            const prepared = await preparedFixture();
            let calls = 0;
            let submitted: unknown = null;
            const sender = {
                async submitReport(report: unknown) {
                    submitted = report;
                    // Submission happens after all initial local files and hashes exist.
                    expect(
                        JSON.parse(readFileSync(join(dirname(prepared.statePath), 'report.json'), 'utf8')).decision
                            .exitCode,
                    ).toBe(1);
                    expect(readFileSync(join(dirname(prepared.statePath), 'manifest.json'), 'utf8')).toContain(
                        'report.json',
                    );
                    if (mode === 'persistence') {
                        rmSync(join(dirname(prepared.statePath), 'report.md'));
                        mkdirSync(join(dirname(prepared.statePath), 'report.md'));
                    }
                    if (mode === 'rejected') throw new Error('SENTINEL_RAW_REJECTION_C5');
                    if (mode === 'network') {
                        const reader = new McpPublishedReader(
                            'http://127.0.0.1:1/mcp',
                            'fixture',
                            'org',
                            { status: 'unavailable', reason: 'withheld' },
                            { timeoutMs: 100 },
                        );
                        try {
                            return await reader.submitReport(report as ReviewReportInput);
                        } finally {
                            await reader.close();
                        }
                    }
                    return {
                        runId: prepared.state.runId,
                        eventId: `effectiveness://org/review_report_submitted/${prepared.state.runId}`,
                        receivedAt: '2026-10-01T12:00:00.000Z',
                        duplicate: false,
                        rawBody: 'SENTINEL_RAW_RESPONSE_C5',
                    };
                },
            };
            const result = await runReview({
                prepared,
                provider: { provider: 'openrouter', model: 'fixture-model' },
                feedback: mode === 'off' ? 'off' : 'send',
                feedbackSender: sender,
                purpose: 'SENTINEL_LOCAL_PURPOSE_C5',
                fetch: async () => {
                    const call = calls++;
                    const tools =
                        call === 0
                            ? [{ name: 'read_source', input: { side: 'head', path: 'route.ts' } }]
                            : call === 1
                              ? [
                                    {
                                        name: 'submit_results',
                                        input: {
                                            results: submissions(prepared).map((r) => ({
                                                ...r,
                                                explanation: 'SENTINEL_LOCAL_EXPLANATION_C5',
                                                limitations: ['SENTINEL_LOCAL_LIMITATIONS_C5'],
                                            })),
                                        },
                                    },
                                ]
                              : [{ name: 'finish_review', input: { scope: 'SENTINEL_LOCAL_SCOPE_C5' } }];
                    return response('openrouter', tools, call);
                },
            });
            expect(result.state.decision).toMatchObject({ exitCode: 1, reviewExit: 1 });
            expect(result.state.entries.every((e) => e.result.disposition === 'evaluated')).toBe(true);
            expect(result.state.execution.reporting.status).toBe(
                mode === 'off' ? 'off' : mode === 'send' ? 'received' : 'failed',
            );
            expect(JSON.stringify(result.state.execution.reporting)).not.toMatch(/SENTINEL/u);
            if (mode === 'off') expect(submitted).toBeNull();
            else
                expect(JSON.stringify(submitted)).not.toMatch(
                    /SENTINEL|explanation|purpose|path|quote|rawBody|reportPath/u,
                );
            expect(JSON.stringify(result.state)).toContain('SENTINEL_LOCAL_EXPLANATION_C5');
            const state = JSON.parse(readFileSync(result.statePath, 'utf8'));
            const report = JSON.parse(readFileSync(result.reportPath, 'utf8'));
            expect(report).toEqual(state);
            if (mode === 'persistence') {
                expect(result.state.execution.reporting).toEqual({
                    status: 'failed',
                    code: 'local_status_write_failed',
                });
                expect(
                    JSON.parse(readFileSync(join(result.directory, 'reporting-status.json'), 'utf8')).reporting,
                ).toEqual(result.state.execution.reporting);
                expect(() => readFileSync(join(result.directory, 'manifest.json'))).toThrow();
                return;
            }
            expect(report.execution.reporting).toEqual(result.state.execution.reporting);
            const manifest = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8'));
            for (const [name, hash] of Object.entries(manifest.files))
                expect(hash).toBe(
                    `sha256:${createHash('sha256')
                        .update(readFileSync(join(result.directory, name)))
                        .digest('hex')}`,
                );
            expect(readFileSync(join(result.directory, 'audit.jsonl'), 'utf8')).toContain('review_reporting');
        },
    );
    it('C5 projection rejects oversized scope without truncating the local report', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
        const prepared = await preparedFixture();
        const result = await runReview({
            prepared,
            provider: { provider: 'openrouter', model: 'fixture-model' },
            feedback: 'off',
            limits: { maxTurns: 1 },
            fetch: async () => response('openrouter', [{ name: 'finish_review', input: { scope: 'fixture' } }], 0),
        });
        const local = structuredClone(result.state);
        local.entries = Array.from({ length: 5001 }, (_, i) => ({
            ...local.entries[0]!,
            assessmentId: `entry-${i}`,
            nodeId: `context://engineering/c${i}`,
        }));
        local.expectedContextCount = local.entries.length;
        expect(await sendReviewReport(local, {})).toEqual({ status: 'failed', code: 'projection_invalid' });
        expect(local.entries).toHaveLength(5001);
    });
    for (const provider of ['openai', 'openrouter'] as const)
        it(`${provider}: explains an invented search cursor and recovers with a null initial cursor`, async () => {
            vi.stubEnv(provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY', 'test-key');
            const prepared = await preparedFixture();
            let call = 0;
            const fetcher: typeof fetch = async () =>
                response(
                    provider,
                    [
                        {
                            name: 'search_source',
                            input: {
                                side: 'head',
                                literal: 'authorize',
                                path: 'policy.ts',
                                ...(call === 0
                                    ? { cursor: { scope: 'policy.ts', entryOffset: 0, characterOffset: 0 } }
                                    : { cursor: null }),
                            },
                        },
                    ],
                    call++,
                );
            const result = await runReview({
                prepared,
                provider: { provider, model: 'requested-model' },
                limits: { maxTurns: 2 },
                fetch: fetcher,
            });
            const events = readFileSync(join(result.directory, 'audit.jsonl'), 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            const failure = events.find((event) => event.kind === 'tool_error');
            expect(failure.data).toMatchObject({ name: 'search_source', error: 'invalid_cursor' });
            expect(failure.data.correction).toContain('Set cursor to null or omit it for the initial search');
            expect(failure.data.correction).toContain('same side and literal');
            expect(failure.data.correction).toContain('never a path or repository label');
            const recovered = events.find(
                (event) => event.kind === 'tool_response' && event.data.name === 'search_source',
            );
            expect(recovered.data.result).toMatchObject({ status: 'complete', evidence: 'literal_navigation_only' });
            expect(recovered.data.result.items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ entry: expect.objectContaining({ path: 'policy.ts' }) }),
                ]),
            );
            expect(result.state.execution.stopReason).toBe('max_turns');
            expect(result.state.decision?.exitCode).toBe(2);
            expect(result.state.entries.every((entry) => entry.result.disposition === 'not_evaluated')).toBe(true);
        });
    for (const provider of ['openai', 'openrouter'] as const)
        it(`${provider}: tools, per-result rejection, correction, checkpoint and complete audit`, async () => {
            vi.stubEnv(
                provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY',
                'test-secret-key-never-capture',
            );
            const prepared = await preparedFixture();
            let call = 0;
            const requests: Array<Record<string, unknown>> = [];
            const fetcher: typeof fetch = async (url, init) => {
                expect(String(url)).toBe(
                    provider === 'openai'
                        ? 'https://api.openai.com/v1/responses'
                        : 'https://openrouter.ai/api/v1/chat/completions',
                );
                const request = JSON.parse(init!.body as string) as Record<string, unknown>;
                requests.push(request);
                expect(request.model).toBe(provider === 'openai' ? 'gpt-5-mini' : 'requested-model');
                expect(request.tools).toBeTruthy();
                let calls: Array<{ name: string; input: unknown }>;
                if (call === 0)
                    calls = [
                        { name: 'changes', input: {} },
                        { name: 'list_source', input: { side: 'head' } },
                        { name: 'search_source', input: { side: 'head', literal: 'authorize' } },
                    ];
                else if (call === 1)
                    calls = [
                        { name: 'read_source', input: { side: 'head', path: 'route.ts' } },
                        { name: 'read_source', input: { side: 'head', path: 'policy.ts' } },
                    ];
                else if (call === 2) {
                    const values = submissions(prepared);
                    calls = [
                        {
                            name: 'submit_results',
                            input: {
                                results: [
                                    values[0],
                                    { ...values[1], citations: [{ ref: 'unknown', quote: 'invented' }] },
                                ],
                            },
                        },
                    ];
                } else if (call === 3) {
                    const values = submissions(prepared);
                    calls = [
                        {
                            name: 'submit_results',
                            input: {
                                results: [
                                    {
                                        ...values[0],
                                        revisionOf: 1,
                                        explanation:
                                            'Explicit corrected explanation, same established bypass. test-secret-key-never-capture',
                                    },
                                    {
                                        ...values[1],
                                        disposition: 'unresolved',
                                        finding: 'none',
                                        adherence: null,
                                        confidence: null,
                                        explanation: 'Decisive further evidence unavailable.',
                                    },
                                ],
                            },
                        },
                    ];
                } else
                    calls = [
                        { name: 'finish_review', input: { scope: 'The changed route and supporting policy only.' } },
                    ];
                return response(provider, calls, call++);
            };
            const result = await runReview({
                prepared,
                provider: {
                    provider,
                    model: provider === 'openai' ? 'gpt-5-mini' : 'requested-model',
                    effort: 'medium',
                },
                fetch: fetcher,
            });
            expect(result.state.decision).toMatchObject({ exitCode: 1, reviewExit: 1, complete: false });
            expect(result.state.entries[0]!.result).toMatchObject({ revision: 2, finding: 'binding_violation' });
            expect(result.state.entries[1]!.result).toMatchObject({
                disposition: 'unresolved',
                adherence: null,
                confidence: null,
            });
            expect(result.state.execution.calls).toBe(5);
            expect(result.state.execution.returnedIdentities[0]).toMatchObject({ model: 'returned-model' });
            const audit = readFileSync(join(result.directory, 'audit.jsonl'), 'utf8');
            expect(audit).toContain('result_rejected');
            expect(audit).toContain('result_accepted');
            expect(audit).not.toContain('test-secret-key-never-capture');
            expect(JSON.stringify(result.state)).not.toContain('test-secret-key-never-capture');
            expect(readFileSync(join(result.directory, 'report.md'), 'utf8')).not.toContain(
                'test-secret-key-never-capture',
            );
            expect(JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8')).files['report.json']).toBe(
                `sha256:${createHash('sha256').update(readFileSync(result.reportPath)).digest('hex')}`,
            );
            if (provider === 'openai')
                expect(requests[0]).toMatchObject({ store: false, reasoning: { effort: 'medium' } });
            else
                expect(requests[0]).toMatchObject({
                    reasoning: { effort: 'medium', exclude: true },
                    usage: { include: true },
                });
        });
    for (const stop of ['provider', 'cancel', 'turns', 'tokens'] as const)
        it(`preserves accepted blocker when stopped by ${stop}`, async () => {
            vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
            const prepared = await preparedFixture();
            const controller = new AbortController();
            let call = 0;
            const fetcher: typeof fetch = async () => {
                if (call === 0)
                    return response(
                        'openrouter',
                        [{ name: 'read_source', input: { side: 'head', path: 'route.ts' } }],
                        call++,
                    );
                if (call === 1)
                    return response(
                        'openrouter',
                        [{ name: 'submit_results', input: { results: [submissions(prepared)[0]] } }],
                        call++,
                    );
                if (stop === 'cancel') {
                    controller.abort();
                    throw new DOMException('Aborted', 'AbortError');
                }
                return new Response('sensitive provider failure must not appear', { status: 503 });
            };
            const result = await runReview({
                prepared,
                provider: { provider: 'openrouter', model: 'fixture' },
                fetch: fetcher,
                signal: controller.signal,
                limits: stop === 'turns' ? { maxTurns: 2 } : stop === 'tokens' ? { maxTotalTokens: 40 } : {},
            });
            expect(result.state.entries[0]!.result).toMatchObject({ finding: 'binding_violation', revision: 1 });
            expect(result.state.entries[1]!.result.disposition).toBe('not_evaluated');
            expect(result.state.decision?.reviewExit).toBe(1);
            expect(result.state.decision?.exitCode).toBe(stop === 'provider' || stop === 'cancel' ? 2 : 1);
            expect(readFileSync(join(result.directory, 'audit.jsonl'), 'utf8')).not.toContain(
                'sensitive provider failure',
            );
            expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).reviewStatus).toBe('incomplete');
        });
    it('reports absent usage explicitly and stops an unenforceable token cutoff', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
        const prepared = await preparedFixture();
        const result = await runReview({
            prepared,
            provider: { provider: 'openrouter', model: 'fixture' },
            limits: { maxTotalTokens: 100 },
            fetch: async () => response('openrouter', [{ name: 'changes', input: {} }], 0, false),
        });
        expect(result.state.execution.stopReason).toBe('total_token_limit_unmeasurable');
        expect(result.state.execution.usage[0]).toMatchObject({
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
        });
        expect(result.state.decision?.exitCode).toBe(2);
    });
});

describe('additional failure and identity boundaries', () => {
    it('rejects duplicates and unknown identities while preserving a valid peer', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
        const prepared = await preparedFixture();
        let call = 0;
        const result = await runReview({
            prepared,
            provider: { provider: 'openrouter', model: 'fixture' },
            fetch: async () => {
                if (call === 0)
                    return response(
                        'openrouter',
                        [{ name: 'read_source', input: { side: 'head', path: 'route.ts' } }],
                        call++,
                    );
                const values = submissions(prepared);
                if (call === 1)
                    return response(
                        'openrouter',
                        [
                            {
                                name: 'submit_results',
                                input: {
                                    results: [
                                        values[0],
                                        values[0],
                                        { ...values[0], assessmentId: 'unknown' },
                                        values[1],
                                    ],
                                },
                            },
                        ],
                        call++,
                    );
                if (call === 2)
                    return response(
                        'openrouter',
                        [
                            {
                                name: 'submit_results',
                                input: {
                                    results: [
                                        {
                                            ...values[0],
                                            disposition: 'unresolved',
                                            adherence: null,
                                            confidence: null,
                                            finding: 'none',
                                        },
                                    ],
                                },
                            },
                        ],
                        call++,
                    );
                return response('openrouter', [{ name: 'finish_review', input: { scope: 'Fixture only.' } }], call++);
            },
        });
        expect(result.state.entries[0]!.result).toMatchObject({ disposition: 'unresolved', revision: 1 });
        expect(result.state.entries[1]!.result).toMatchObject({ disposition: 'evaluated', revision: 1 });
        expect(result.state.decision).toMatchObject({ reviewExit: 1, counts: { evaluated: 1, unresolved: 1 } });
        const audit = readFileSync(join(result.directory, 'audit.jsonl'), 'utf8');
        expect(audit).toContain('Duplicate assessmentId');
        expect(audit).toContain('Unknown assessmentId');
    });
    it('reports mandatory report failure honestly and retains the underlying blocker', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
        const prepared = await preparedFixture();
        let call = 0;
        mkdirSync(join(dirname(prepared.statePath), 'report.md'));
        const result = await runReview({
            prepared,
            provider: { provider: 'openrouter', model: 'fixture' },
            fetch: async () => {
                if (call === 0)
                    return response(
                        'openrouter',
                        [{ name: 'read_source', input: { side: 'head', path: 'route.ts' } }],
                        call++,
                    );
                if (call === 1)
                    return response(
                        'openrouter',
                        [{ name: 'submit_results', input: { results: submissions(prepared) } }],
                        call++,
                    );
                return response('openrouter', [{ name: 'finish_review', input: { scope: 'Fixture only.' } }], call++);
            },
        });
        expect(result.state.decision).toMatchObject({ exitCode: 2, reviewExit: 1 });
        expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).execution.stopReason).toBe('report_delivery_failed');
        expect(result.state.entries.every((e) => e.result.disposition === 'evaluated')).toBe(true);
    });
    it('rejects tampered pinned material before a provider request', async () => {
        const prepared = await preparedFixture();
        const publications = JSON.parse(readFileSync(prepared.materialPath, 'utf8'));
        publications[prepared.state.entries[0]!.assessmentId].content.body = 'Changed after preparation';
        writeFileSync(prepared.materialPath, JSON.stringify(publications));
        const fetcher = vi.fn();
        const result = await runReview({
            prepared,
            provider: { provider: 'openrouter', model: 'fixture' },
            fetch: fetcher,
        });
        expect(result.state.execution.stopReason).toBe('pinned_material_changed');
        expect(fetcher).not.toHaveBeenCalled();
        expect(result.state.decision?.exitCode).toBe(2);
    });
    it('cancels an in-flight provider at the configured deadline without losing the report', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
        const prepared = await preparedFixture();
        const result = await runReview({
            prepared,
            provider: { provider: 'openrouter', model: 'fixture' },
            limits: { maxTimeMs: 20 },
            fetch: async (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
                    if (init?.signal?.aborted) cancel();
                    else init?.signal?.addEventListener('abort', cancel, { once: true });
                }),
        });
        expect(result.state.execution.stopReason).toBe('max_time_ms');
        expect(result.state.decision?.exitCode).toBe(2);
        expect(
            JSON.parse(readFileSync(result.reportPath, 'utf8')).entries.every(
                (e: { result: { disposition: string } }) => e.result.disposition === 'not_evaluated',
            ),
        ).toBe(true);
    });
});
