import { wrapLanguageModel } from 'ai';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenAI } from '@ai-sdk/openai';

export type ReviewProvider = 'openai' | 'openrouter';
export type ProviderConfiguration = {
    provider: ReviewProvider;
    model: string;
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

function providerErrorMessage(body: unknown): string {
    const object = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    const error = object?.error;
    const message = error && typeof error === 'object' ? (error as Record<string, unknown>).message : null;
    return typeof message === 'string' ? message.slice(0, 1000) : '';
}

/** Classify known HTTP failures without persisting provider messages or metadata. */
export const PROVIDER_FAILURE_CODES = [
    'provider_credit_limit',
    'provider_credential_invalid',
    'provider_rate_limited',
    'provider_permission_denied',
    'provider_schema_invalid',
    'provider_unavailable',
    'provider_request_failed',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];
export function providerHttpFailure(status: number, body: unknown): ProviderFailureCode {
    const knownMessage = providerErrorMessage(body);
    if (status === 402 || (status === 403 && /\bkey spending limit exceeded\b/iu.test(knownMessage)))
        return 'provider_credit_limit';
    if (status === 401) return 'provider_credential_invalid';
    if (status === 429) return 'provider_rate_limited';
    if (status === 403) return 'provider_permission_denied';
    if (status === 400 && /\binvalid (?:json )?schema\b/iu.test(knownMessage)) return 'provider_schema_invalid';
    if (status >= 500 && status <= 599) return 'provider_unavailable';
    return 'provider_request_failed';
}

const categories = new Set([
    'AI_APICallError',
    'AI_TypeValidationError',
    'AI_JSONParseError',
    'ZodError',
    'SyntaxError',
]);
const fields = new Set([
    'choices',
    'message',
    'role',
    'content',
    'reasoning',
    'reasoning_details',
    'type',
    'data',
    'format',
    'id',
    'index',
    'text',
    'summary',
    'signature',
    'tool_calls',
    'function',
    'name',
    'arguments',
    'finish_reason',
    'usage',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'error',
    'code',
    'output',
    'status',
    'annotations',
    'images',
]);
const types = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null', 'undefined']);
const codes = new Set(['invalid_type', 'invalid_value', 'too_big', 'too_small', 'invalid_format', 'unrecognized_keys']);
function diagnosticValueAt(value: unknown, path: unknown[]) {
    let actual = value;
    for (const key of path) {
        actual =
            actual && typeof actual === 'object' && (typeof key === 'string' || typeof key === 'number')
                ? (actual as Record<string | number, unknown>)[key]
                : undefined;
    }
    return actual;
}
function diagnosticPathPart(key: unknown): string | number {
    if (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0) return key;
    return typeof key === 'string' && fields.has(key) ? key : '[field]';
}
function diagnosticType(value: unknown, available: boolean) {
    if (!available) return 'unavailable';
    if (value === null) return 'null';
    return Array.isArray(value) ? 'array' : typeof value;
}

/** Map parser messages to fixed categories; never retain the message or rejected text. */
function parseFailure(cause: Record<string, unknown>) {
    const message = typeof cause.message === 'string' ? cause.message : '';
    if (message === 'Object contains forbidden prototype property') return 'prototype_property_rejected';
    if (message === 'Unexpected end of JSON input') return 'unexpected_end';
    if (message.startsWith('Unterminated string')) return 'unterminated_string';
    if (message.startsWith('Bad control character')) return 'invalid_control_character';
    if (message.startsWith('Unexpected token')) return 'unexpected_token';
    return 'syntax_error';
}
/** Capture schema failures without copying exception messages, response values or arbitrary field names. */
export function providerFailureDiagnostics(error: unknown) {
    const causes: string[] = [];
    const validation: Array<{ code: string; path: Array<string | number>; expected: string; actual: string }> = [];
    let parse: { code: string; bytes: number | null } | undefined;
    let rejectedBytes: number | null = null;
    let value: unknown;
    let hasValue = false;
    const collect = (issues: unknown, depth = 0) => {
        if (!Array.isArray(issues) || depth > 4) return;
        for (const issue of issues.slice(0, 16)) {
            if (!issue || typeof issue !== 'object' || validation.length >= 16) continue;
            if (issue.code === 'invalid_union' && Array.isArray(issue.errors)) {
                for (const branch of issue.errors.slice(0, 8)) collect(branch, depth + 1);
            }
            if (!codes.has(issue.code) || !Array.isArray(issue.path)) continue;
            const path = issue.path.slice(0, 16) as unknown[];
            validation.push({
                code: issue.code,
                path: path.map(diagnosticPathPart),
                expected: types.has(issue.expected) ? issue.expected : 'unavailable',
                actual: diagnosticType(diagnosticValueAt(value, path), hasValue),
            });
        }
    };
    let current = error;
    for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
        const cause = current as Record<string, unknown>;
        causes.push(typeof cause.name === 'string' && categories.has(cause.name) ? cause.name : 'other');
        if (cause.name === 'AI_JSONParseError' && typeof cause.text === 'string')
            rejectedBytes = Buffer.byteLength(cause.text, 'utf8');
        if (cause.name === 'SyntaxError') parse = { code: parseFailure(cause), bytes: rejectedBytes };
        if (cause.name === 'AI_TypeValidationError' && 'value' in cause) {
            value = cause.value;
            hasValue = true;
        }
        collect(cause.issues);
        current = cause.cause;
    }
    return { causes, validation, ...(parse ? { parse } : {}) };
}

/** Retry only failed provider operations, before any response tools execute. */
export function recoverProviderCalls(
    model: Parameters<typeof wrapLanguageModel>[0]['model'],
    signal: AbortSignal,
    onRecovery: (
        event: 'provider_retry' | 'provider_recovered' | 'provider_retry_exhausted',
        retry: number,
        error?: unknown,
    ) => Promise<unknown>,
): ReturnType<typeof wrapLanguageModel> {
    return wrapLanguageModel({
        model,
        middleware: {
            specificationVersion: 'v4',
            wrapGenerate: async ({ doGenerate }) => {
                let retries = 0;
                for (;;) {
                    signal.throwIfAborted();
                    try {
                        const response = await doGenerate();
                        if (retries) await onRecovery('provider_recovered', retries);
                        return response;
                    } catch (error) {
                        if (signal.aborted || !recoverableProviderError(error)) throw error;
                        if (retries >= 2) {
                            await onRecovery('provider_retry_exhausted', retries, error);
                            throw error;
                        }
                        retries++;
                        await onRecovery('provider_retry', retries, error);
                        await delay(250 * 2 ** (retries - 1), undefined, { signal });
                    }
                }
            },
        },
    });
}

function recoverableProviderError(error: unknown): boolean {
    // Our usage reader parses the same response before the SDK; malformed JSON can surface here directly.
    if (error instanceof SyntaxError) return true;
    if (!(error instanceof Error) || error.name !== 'AI_APICallError') return false;
    const failure = error as Error & { statusCode?: number; isRetryable?: boolean };
    const status = failure.statusCode;
    if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true;
    if (status === undefined) return failure.isRetryable === true;
    // A successful HTTP response can still fail SDK parsing/validation. Never relax that validation.
    return (
        status >= 200 &&
        status < 300 &&
        providerFailureDiagnostics(error).causes.some(
            (cause) => cause === 'AI_JSONParseError' || cause === 'AI_TypeValidationError',
        )
    );
}

/** Construction only; no model substitution, retries, or domain policy. */
export function reviewModel(
    config: ProviderConfiguration,
    fetcher: typeof fetch = fetch,
): {
    model: Parameters<typeof wrapLanguageModel>[0]['model'];
    providerOptions: Record<string, Record<string, string | boolean>>;
} {
    if (!['openai', 'openrouter'].includes(config.provider)) throw new Error('provider_selection_invalid');
    const key = process.env[config.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'];
    if (!key?.trim()) throw new Error('provider_credential_missing');
    if (!config.model.trim()) throw new Error('provider_model_missing');
    if (config.provider === 'openai') {
        return {
            model: createOpenAI({ apiKey: key, fetch: fetcher }).responses(config.model),
            providerOptions: { openai: { store: false, ...(config.effort ? { reasoningEffort: config.effort } : {}) } },
        };
    }
    return {
        // The OpenRouter adapter currently drops function.strict. The existing
        // OpenAI-compatible chat adapter forwards it without rewriting requests.
        model: createOpenAI({
            apiKey: key,
            baseURL: 'https://openrouter.ai/api/v1',
            name: 'openrouter',
            fetch: fetcher,
        }).chat(config.model),
        providerOptions: {
            openai: {
                store: false,
                forceReasoning: true,
                ...(config.effort ? { reasoningEffort: config.effort } : {}),
            },
        },
    };
}

/** Normalize only provider-reported numbers; SDK fallbacks must not turn absence into zero. */
export function reportedUsage(provider: ReviewProvider, value: unknown) {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    const number = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const names =
        provider === 'openai'
            ? {
                  input: 'input_tokens',
                  output: 'output_tokens',
                  inputDetails: 'input_tokens_details',
                  outputDetails: 'output_tokens_details',
              }
            : {
                  input: 'prompt_tokens',
                  output: 'completion_tokens',
                  inputDetails: 'prompt_tokens_details',
                  outputDetails: 'completion_tokens_details',
              };
    const inputDetails = raw?.[names.inputDetails] as Record<string, unknown> | undefined;
    const outputDetails = raw?.[names.outputDetails] as Record<string, unknown> | undefined;
    return {
        inputTokens: number(raw?.[names.input]),
        outputTokens: number(raw?.[names.output]),
        totalTokens: number(raw?.total_tokens),
        cachedInputTokens: number(inputDetails?.cached_tokens),
        reasoningTokens: number(outputDetails?.reasoning_tokens),
        cost: number(raw?.cost),
        raw,
        missing: raw === null ? 'provider_did_not_report' : null,
    };
}
