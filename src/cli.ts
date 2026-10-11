#!/usr/bin/env node
import { packageVersion } from './version.js';
import { parseArgs } from 'node:util';
import { fixGitIdentity } from './git.js';
import { McpPublishedReader, mcpTimeoutMs } from './mcp.js';
import { prepareReview } from './prepare.js';
import { runReview, DEFAULT_EXECUTION_LIMITS, type ExecutionLimits } from './review.js';
import { DEFAULT_SOURCE_LIMITS, type SourceLimits } from './source.js';
import type { ProviderConfiguration } from './providers.js';
import type { ReviewPolicy } from './results.js';

// SDK warnings are captured and redacted in the audit; avoid uncontrolled CLI logging.
(globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const executionFlags = {
    'max-turns': 'maxTurns',
    'max-output-tokens': 'maxOutputTokens',
    'max-total-tokens': 'maxTotalTokens',
    'max-time-ms': 'maxTimeMs',
} as const;
const sourceFlags = {
    'source-page-entries': 'pageEntries',
    'source-search-matches': 'searchMatches',
    'source-search-files': 'searchFiles',
    'source-read-lines': 'readLines',
    'source-read-bytes': 'readBytes',
    'source-timeout-ms': 'timeoutMs',
} as const;
const help = `Usage: contextrail-review prepare|review --reviewer skill://domain/reviewer --repo DIR --base REF --head REF

Review Git changes against your published organizational guidance.
Inspect results and source evidence under .contextrail/reviewer/<run-id>/.
Both commands fix the Git commits and retrieve exact published guidance versions.
prepare exit 0 means prepared, with no evaluation; incomplete preparation exits 2.
review adds one model/tool session, validated progressive results, local audit and JSON/Markdown reports.
Requires CONTEXTRAIL_MCP_URL, CONTEXTRAIL_MCP_AUTH_TOKEN, CONTEXTRAIL_MCP_ORG_ID.
--mcp-timeout-ms N overrides CONTEXTRAIL_MCP_TIMEOUT_MS (default 30000, Node timer range).

review requires --provider openai|openrouter and --model PROVIDER_NATIVE_ID
(or CONTEXTRAIL_REVIEW_PROVIDER / CONTEXTRAIL_REVIEW_MODEL). CLI overrides environment.
Credentials: OPENAI_API_KEY / OPENROUTER_API_KEY. No implicit provider/model fallback.
--effort none|minimal|low|medium|high|xhigh (provider/model must support it).
--purpose TEXT supplies caller-stated objective/stage; no inferred objective is treated as approved.
--min-adherence 0|1|2 adds a supported adherence gate; omitted means no numerical gate.
--min-confidence 1|2|3 requires model-reported confidence, including nonapplicability; missing/low confidence is incomplete.
--advisory suppresses finding/adherence blockers, never missing scope or execution/report failure.
Exit 0: bounded completed review accepted by policy; 1: qualifying supported blocker;
2: incomplete or execution/report error. Underlying review exit is preserved separately.

Execution settings: --max-turns N, --max-output-tokens N, --max-total-tokens N, --max-time-ms N.
Default: unset (no package ceiling; provider output/context constraints still apply).
Total-token cutoff is observed after calls, can overshoot by one call; missing usage prevents enforcement.
Per-call output allowance includes provider reasoning tokens where applicable.
Source response/operation settings (positive integers, read-bytes >=4):
${Object.entries(sourceFlags)
    .map(([flag, key]) => `--${flag} N (default ${DEFAULT_SOURCE_LIMITS[key]})`)
    .join('\n')}
Every review option has CONTEXTRAIL_REVIEW_<UPPERCASE_FLAG_WITH_UNDERSCORES> equivalent.
Set advisory environment to true or false. Limits are operational settings, not scope requirements.
--feedback send|off (default send) submits minimal metadata after finalization.
--repository-attribution explicitly includes repository identity in reports and preparation environment.
Feedback off suppresses metadata submission; local reports are still written.
Ordinary ContextRail retrieval still emits delivery events.
Export credentials into this process; the CLI does not load .env files.
No uploads, runtime code execution or hidden reasoning capture. Cancellation preserves accepted work.
`;
function positive(value: string | undefined, flag: string): number | null {
    if (value === undefined) return null;
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
        throw new CliInputError(`${flag} must be a positive safe integer.`);
    return Number(value);
}
class CliInputError extends Error {}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            reviewer: { type: 'string' },
            repo: { type: 'string', default: process.cwd() },
            base: { type: 'string' },
            head: { type: 'string' },
            'mcp-timeout-ms': { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            purpose: { type: 'string' },
            'min-adherence': { type: 'string' },
            'min-confidence': { type: 'string' },
            advisory: { type: 'boolean' },
            feedback: { type: 'string' },
            'repository-attribution': { type: 'boolean' },
            ...Object.fromEntries(
                [...Object.keys(executionFlags), ...Object.keys(sourceFlags)].map((flag) => [
                    flag,
                    { type: 'string' as const },
                ]),
            ),
            help: { type: 'boolean' },
            version: { type: 'boolean' },
        },
    });
    if (values.help) {
        process.stdout.write(help);
        return;
    }
    if (values.version) {
        process.stdout.write(`${packageVersion}\n`);
        return;
    }
    if (
        positionals.length !== 1 ||
        !['prepare', 'review'].includes(positionals[0]!) ||
        !values.reviewer ||
        !values.base ||
        !values.head
    )
        throw new CliInputError('Use prepare or review with --reviewer, --base and --head. See --help.');
    const isReview = positionals[0] === 'review';
    const setting = (flag: string) =>
        ((values as Record<string, string | boolean | undefined>)[flag] as string | undefined) ??
        process.env[`CONTEXTRAIL_REVIEW_${flag.toUpperCase().replaceAll('-', '_')}`];
    const feedback = setting('feedback') ?? 'send';
    if (!['send', 'off'].includes(feedback)) throw new CliInputError('feedback must be send or off.');
    const repositorySetting = process.env.CONTEXTRAIL_REVIEW_REPOSITORY_ATTRIBUTION;
    if (repositorySetting !== undefined && !['true', 'false'].includes(repositorySetting))
        throw new CliInputError('repository attribution must be true or false.');
    const repositoryAttribution =
        (values['repository-attribution'] as boolean | undefined) ?? repositorySetting === 'true';
    let provider: ProviderConfiguration | undefined;
    const limits: ExecutionLimits = { ...DEFAULT_EXECUTION_LIMITS };
    const sourceLimits: Partial<SourceLimits> = {};
    const policy: ReviewPolicy = {
        minAdherence: null,
        minConfidence: null,
        advisory: (values.advisory as boolean | undefined) ?? process.env.CONTEXTRAIL_REVIEW_ADVISORY === 'true',
    };
    if (isReview) {
        const p = setting('provider'),
            model = setting('model'),
            effort = setting('effort');
        if (!p || !['openai', 'openrouter'].includes(p) || !model?.trim())
            throw new CliInputError(
                'review requires explicit --provider openai|openrouter and --model (or environment).',
            );
        if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort))
            throw new CliInputError('Invalid --effort. See --help.');
        provider = {
            provider: p as ProviderConfiguration['provider'],
            model,
            ...(effort ? { effort: effort as ProviderConfiguration['effort'] } : {}),
        };
        for (const [flag, key] of Object.entries(executionFlags)) limits[key] = positive(setting(flag), flag);
        for (const [flag, key] of Object.entries(sourceFlags)) {
            const value = positive(setting(flag), flag);
            if (value !== null) sourceLimits[key] = value;
        }
        if (
            (limits.maxTimeMs !== null && limits.maxTimeMs > 2_147_483_647) ||
            (sourceLimits.timeoutMs !== undefined && sourceLimits.timeoutMs > 2_147_483_647)
        )
            throw new CliInputError('Time limit exceeds the Node timer interval.');
        if (sourceLimits.readBytes !== undefined && sourceLimits.readBytes < 4)
            throw new CliInputError('source-read-bytes must be >=4.');
        const adherence = setting('min-adherence'),
            confidence = setting('min-confidence');
        if (adherence !== undefined && !['0', '1', '2'].includes(adherence))
            throw new CliInputError('min-adherence must be 0, 1 or 2.');
        if (confidence !== undefined && !['1', '2', '3'].includes(confidence))
            throw new CliInputError('min-confidence must be 1, 2 or 3.');
        if (adherence !== undefined) policy.minAdherence = Number(adherence) as ReviewPolicy['minAdherence'];
        if (confidence !== undefined) policy.minConfidence = Number(confidence) as ReviewPolicy['minConfidence'];
        if (
            process.env.CONTEXTRAIL_REVIEW_ADVISORY !== undefined &&
            !['true', 'false'].includes(process.env.CONTEXTRAIL_REVIEW_ADVISORY)
        )
            throw new CliInputError('CONTEXTRAIL_REVIEW_ADVISORY must be true or false.');
    }
    const timeoutMs = mcpTimeoutMs(
        (values['mcp-timeout-ms'] as string | undefined) ?? process.env.CONTEXTRAIL_MCP_TIMEOUT_MS,
    );
    if (!(values.reviewer as string).startsWith('skill://'))
        throw new CliInputError('--reviewer must be a skill:// ID.');
    let artifact;
    try {
        artifact = fixGitIdentity(values.repo as string, values.base as string, values.head as string);
    } catch {
        throw new CliInputError('Cannot resolve repository and base/head references to Git commits.');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    const reader = new McpPublishedReader(
        process.env.CONTEXTRAIL_MCP_URL ?? '',
        process.env.CONTEXTRAIL_MCP_AUTH_TOKEN ?? '',
        process.env.CONTEXTRAIL_MCP_ORG_ID ?? '',
        artifact.repositoryEnvironment,
        { timeoutMs, signal: controller.signal, repositoryAttribution },
    );
    try {
        const prepared = await prepareReview({
            repository: values.repo as string,
            base: values.base as string,
            head: values.head as string,
            reviewerId: values.reviewer as string,
            reader,
            artifact,
        });
        if (isReview) {
            const result = await runReview({
                prepared,
                provider: provider!,
                policy,
                limits,
                sourceLimits,
                feedback: feedback as 'send' | 'off',
                feedbackSender: reader,
                repositoryAttribution,
                purpose: setting('purpose'),
                signal: controller.signal,
            });
            process.stdout.write(
                `${JSON.stringify({ runId: result.state.runId, reviewStatus: result.state.reviewStatus, decision: result.state.decision, reportPath: result.reportPath, directory: result.directory, execution: result.state.execution })}\n`,
            );
            process.exitCode = result.state.decision?.exitCode ?? 2;
        } else {
            process.stdout.write(
                `${JSON.stringify({ preparationStatus: prepared.state.preparationStatus, reviewStatus: prepared.state.reviewStatus, statePath: prepared.statePath, materialPath: prepared.materialPath, expectedContexts: prepared.state.expectedContextCount, recordedEntries: prepared.state.entries.length, gaps: prepared.state.gaps })}\n`,
            );
            process.exitCode = prepared.state.preparationStatus === 'prepared' ? 0 : 2;
        }
    } finally {
        await reader.close();
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
    }
}
main().catch((error: unknown) => {
    process.stderr.write(
        error instanceof CliInputError
            ? `${error.message}\n`
            : 'Invalid configuration or unavailable local review output. See --help; inspect any saved run state.\n',
    );
    process.exitCode = 2;
});
