import { describe, expect, it } from 'vitest';
import {
    providerHttpDiagnostics,
    providerHttpFailure,
    providerRequestDiagnostics,
    providerResponseDiagnostics,
    providerTransportDiagnostics,
} from '../src/providers.js';

describe('safe provider diagnostics', () => {
    it.each([
        [400, { code: 'context_length_exceeded' }, 'provider_context_limit'],
        [400, { message: 'Maximum context length exceeded for SECRET source' }, 'provider_context_limit'],
        [400, { code: 'invalid_function_parameters' }, 'provider_schema_invalid'],
        [400, { message: 'Invalid JSON schema for SECRET' }, 'provider_schema_invalid'],
        [400, { code: 'unsupported_parameter', param: 'reasoning_effort' }, 'provider_parameter_unsupported'],
        [404, { code: 'model_not_found' }, 'provider_model_unavailable'],
        [403, { message: 'key spending limit exceeded SECRET' }, 'provider_credit_limit'],
        [401, {}, 'provider_credential_invalid'],
        [402, {}, 'provider_credit_limit'],
        [403, {}, 'provider_permission_denied'],
        [408, {}, 'provider_timeout'],
        [413, {}, 'provider_request_too_large'],
        [429, {}, 'provider_rate_limited'],
        [503, {}, 'provider_unavailable'],
        [400, { code: 'SECRET', message: 'SECRET', param: 'SECRET' }, 'provider_request_failed'],
    ])('classifies HTTP %s using bounded evidence', (status, error, code) => {
        const result = providerHttpDiagnostics(status, { error });
        expect(result.code).toBe(code);
        expect(providerHttpFailure(status, { error })).toBe(code);
        expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('extracts only known nested OpenRouter code and parameter, not raw payloads', () => {
        const result = providerHttpDiagnostics(400, {
            error: {
                message: 'Provider returned error',
                metadata: {
                    provider_name: 'SECRET',
                    raw: JSON.stringify({
                        error: {
                            code: 'unsupported_parameter',
                            param: 'reasoning_effort',
                            message: 'SECRET source prompt token',
                        },
                    }),
                },
            },
        });
        expect(result).toEqual({
            code: 'provider_parameter_unsupported',
            reason: 'unsupported_parameter',
            evidence: 'structured_code',
            parameter: 'reasoning_effort',
            bodyFormat: 'object',
        });
        expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('does not copy freeform parameter paths or non-JSON error bodies', () => {
        expect(
            providerHttpDiagnostics(400, {
                error: { code: 'unsupported_parameter', param: 'tools[0].SECRET', message: 'SECRET' },
            }).parameter,
        ).toBeNull();
        expect(providerHttpDiagnostics(400, '<html>SECRET upstream error</html>')).toEqual({
            code: 'provider_request_failed',
            reason: 'unknown',
            evidence: 'unknown',
            parameter: null,
            bodyFormat: 'non_json',
        });
        expect(providerHttpDiagnostics(400, 'x'.repeat(65537)).bodyFormat).toBe('too_large');
        const cyclic: Record<string, unknown> = { code: 'SECRET' };
        cyclic.metadata = { raw: cyclic };
        expect(providerHttpDiagnostics(400, cyclic).reason).toBe('unknown');
    });

    it('measures actual request bytes and counts without retaining content', () => {
        const body = JSON.stringify({
            messages: [{ role: 'user', content: 'SECRET 😊' }],
            tools: [{ function: { name: 'SECRET', parameters: { type: 'object' } } }],
            max_completion_tokens: 8192,
        });
        expect(providerRequestDiagnostics(body)).toEqual({
            requestBytes: Buffer.byteLength(body),
            messageCount: 1,
            toolCount: 1,
            toolSchemaBytes: Buffer.byteLength('[{"type":"object"}]'),
            maxOutputTokens: 8192,
            requestFormat: 'json',
        });
        expect(providerRequestDiagnostics(Buffer.from(body))).toEqual(providerRequestDiagnostics(body));
        expect(JSON.stringify(providerRequestDiagnostics(body))).not.toContain('SECRET');
        expect(
            providerRequestDiagnostics(
                JSON.stringify({ input: [{ content: 'SECRET' }], tools: [], max_output_tokens: 25 }),
            ).maxOutputTokens,
        ).toBe(25);
    });

    it('marks unsupported, oversized, and malformed request metadata honestly', () => {
        expect(providerRequestDiagnostics(new FormData()).requestFormat).toBe('unavailable');
        expect(providerRequestDiagnostics('not json').messageCount).toBeNull();
        const body = 'x'.repeat(4 * 1024 * 1024 + 1);
        expect(providerRequestDiagnostics(body)).toMatchObject({
            requestBytes: body.length,
            requestFormat: 'too_large',
            messageCount: null,
            toolCount: null,
        });
        expect(providerRequestDiagnostics('{"max_tokens":-1}').maxOutputTokens).toBeNull();
    });

    it('classifies nested transport codes without messages or addresses', () => {
        expect(
            providerTransportDiagnostics(
                new Error('SECRET hostname', { cause: Object.assign(new Error('SECRET'), { code: 'ECONNRESET' }) }),
            ),
        ).toEqual({ transport: 'connection_reset' });
        expect(providerTransportDiagnostics({ name: 'AbortError', message: 'SECRET' })).toEqual({
            transport: 'aborted',
        });
        expect(providerTransportDiagnostics({ code: 'SECRET' })).toEqual({ transport: 'unknown' });
        expect(providerTransportDiagnostics({ code: '__proto__' })).toEqual({ transport: 'unknown' });
    });

    it('reads bounded response diagnostics without consuming the SDK response', async () => {
        const response = new Response('{"error":{"code":"context_length_exceeded","message":"SECRET"}}', {
            status: 400,
        });
        expect(await providerResponseDiagnostics(response)).toMatchObject({ reason: 'context_length_exceeded' });
        expect(await response.text()).toContain('SECRET');
        const oversized = new Response('x'.repeat(65537), { status: 400 });
        expect(await providerResponseDiagnostics(oversized)).toMatchObject({
            reason: 'unknown',
            bodyFormat: 'too_large',
        });
        await oversized.body?.cancel();
    });

    it('does not replace the provider failure when reading diagnostics fails', async () => {
        const response = new Response(
            new ReadableStream({
                start(controller) {
                    controller.error(new Error('SECRET'));
                },
            }),
            { status: 503 },
        );
        expect(await providerResponseDiagnostics(response)).toMatchObject({
            code: 'provider_unavailable',
            bodyFormat: 'unreadable',
        });
    });
});

it.each(['direct', 'sdk-wrapped'])('never retries a %s local accounting failure', async (mode) => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { generateText } = await import('ai');
    const { ProviderAccountingError, recoverProviderCalls } = await import('../src/providers.js');
    const accounting = new ProviderAccountingError(new SyntaxError('PRIVATE_LOCAL_FAILURE'));
    const error =
        mode === 'direct'
            ? accounting
            : Object.assign(new Error('PRIVATE_WRAPPER', { cause: accounting }), {
                  name: 'AI_APICallError',
                  isRetryable: true,
                  statusCode: 503,
              });
    let requests = 0;
    const recoveries: string[] = [];
    const model = createOpenAI({
        apiKey: 'test',
        fetch: async () => {
            requests++;
            throw error;
        },
    }).chat('test');
    await expect(
        generateText({
            model: recoverProviderCalls(model, new AbortController().signal, async (event) => {
                recoveries.push(event);
            }),
            prompt: 'test',
            maxRetries: 0,
        }),
    ).rejects.toThrow();
    expect(requests).toBe(1);
    expect(recoveries).toEqual([]);
});

it('does not retry a successful response when recovery telemetry fails', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { generateText } = await import('ai');
    const { recoverProviderCalls } = await import('../src/providers.js');
    let requests = 0;
    const model = createOpenAI({
        apiKey: 'test',
        fetch: async () => {
            requests++;
            if (requests === 1) throw new SyntaxError('provider JSON failed');
            return new Response(
                JSON.stringify({
                    id: 'fixture',
                    created: 1,
                    model: 'test',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
                { headers: { 'content-type': 'application/json' } },
            );
        },
    }).chat('test');
    await expect(
        generateText({
            model: recoverProviderCalls(model, new AbortController().signal, async (event) => {
                if (event === 'provider_recovered') throw new SyntaxError('PRIVATE_LOCAL_FAILURE');
            }),
            prompt: 'test',
            maxRetries: 0,
        }),
    ).rejects.toThrow('PRIVATE_LOCAL_FAILURE');
    expect(requests).toBe(2);
});
