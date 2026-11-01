import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export type ReviewProvider = 'openai' | 'openrouter';
export type ProviderConfiguration = {
    provider: ReviewProvider;
    model: string;
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

/** Capture schema failures without copying exception messages, response values or arbitrary field names. */
export function providerFailureDiagnostics(error: unknown) {
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
    const codes = new Set([
        'invalid_type',
        'invalid_value',
        'too_big',
        'too_small',
        'invalid_format',
        'unrecognized_keys',
    ]);
    const causes: string[] = [];
    const validation: Array<{ code: string; path: Array<string | number>; expected: string; actual: string }> = [];
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
            let actual = value;
            for (const key of path) {
                actual =
                    actual && typeof actual === 'object' && (typeof key === 'string' || typeof key === 'number')
                        ? (actual as Record<string | number, unknown>)[key]
                        : undefined;
            }
            validation.push({
                code: issue.code,
                path: path.map((key) =>
                    typeof key === 'number' && Number.isSafeInteger(key) && key >= 0
                        ? key
                        : typeof key === 'string' && fields.has(key)
                          ? key
                          : '[field]',
                ),
                expected: types.has(issue.expected) ? issue.expected : 'unavailable',
                actual: !hasValue
                    ? 'unavailable'
                    : actual === null
                      ? 'null'
                      : Array.isArray(actual)
                        ? 'array'
                        : typeof actual,
            });
        }
    };
    let current = error;
    for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
        const cause = current as Record<string, unknown>;
        causes.push(typeof cause.name === 'string' && categories.has(cause.name) ? cause.name : 'other');
        if (cause.name === 'AI_TypeValidationError' && 'value' in cause) {
            value = cause.value;
            hasValue = true;
        }
        collect(cause.issues);
        current = cause.cause;
    }
    return { causes, validation };
}

/** Construction only; no model substitution, retries, or domain policy. */
export function reviewModel(
    config: ProviderConfiguration,
    fetcher: typeof fetch = fetch,
): { model: LanguageModel; providerOptions: Record<string, Record<string, string | boolean>> } {
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
        model: createOpenRouter({ apiKey: key, fetch: fetcher }).chat(config.model, {
            usage: { include: true },
            ...(config.effort ? { reasoning: { effort: config.effort, exclude: true } } : {}),
        }),
        providerOptions: {},
    };
}

/** Normalize only provider-reported numbers; SDK fallbacks must not turn absence into zero. */
export function reportedUsage(provider: ReviewProvider, value: unknown) {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    const number = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const inputDetails = raw?.[provider === 'openai' ? 'input_tokens_details' : 'prompt_tokens_details'] as
        | Record<string, unknown>
        | undefined;
    const outputDetails = raw?.[provider === 'openai' ? 'output_tokens_details' : 'completion_tokens_details'] as
        | Record<string, unknown>
        | undefined;
    return {
        inputTokens: number(raw?.[provider === 'openai' ? 'input_tokens' : 'prompt_tokens']),
        outputTokens: number(raw?.[provider === 'openai' ? 'output_tokens' : 'completion_tokens']),
        totalTokens: number(raw?.total_tokens),
        cachedInputTokens: number(inputDetails?.cached_tokens),
        reasoningTokens: number(outputDetails?.reasoning_tokens),
        cost: number(raw?.cost),
        raw,
        missing: raw === null ? 'provider_did_not_report' : null,
    };
}
