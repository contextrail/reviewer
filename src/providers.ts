import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export type ReviewProvider = 'openai' | 'openrouter';
export type ProviderConfiguration = {
    provider: ReviewProvider;
    model: string;
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};
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
