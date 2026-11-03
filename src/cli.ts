#!/usr/bin/env node
import { loadPrContext } from './pr-context.js';
import { packageVersion } from './version.js';
import { systemFailureDiagnostics } from './diagnostics.js';
import { parseArgs } from 'node:util';
import { fixGitIdentity } from './git.js';
import { McpPublishedReader, mcpTimeoutMs } from './mcp.js';
import { prepareReview } from './prepare.js';
import { loadReviewCheckpoint } from './resume.js';
import { runReview, DEFAULT_EXECUTION_LIMITS, type ExecutionLimits } from './review.js';
import { DEFAULT_SOURCE_LIMITS, type SourceLimits } from './source.js';
import { providerTransportDiagnostics, type ProviderConfiguration } from './providers.js';
import type { ReviewPolicy } from './results.js';
import { prepareGitHubReview, publishGitHubReview } from './github.js';

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
review runs governed assessment and independent verification with retained phase records.
--resume RUN_DIR reuses a sealed incomplete run with the same comparison and review configuration.
Resume uses the saved publications without fetching newer standards; execution limits apply to this invocation.
Requires CONTEXTRAIL_MCP_URL, CONTEXTRAIL_MCP_AUTH_TOKEN, CONTEXTRAIL_MCP_ORG_ID.
--mcp-timeout-ms N overrides CONTEXTRAIL_MCP_TIMEOUT_MS (default 30000, Node timer range).

review requires --provider openai|openrouter and --model PROVIDER_NATIVE_ID
(or CONTEXTRAIL_REVIEW_PROVIDER / CONTEXTRAIL_REVIEW_MODEL). CLI overrides environment.
Credentials: OPENAI_API_KEY / OPENROUTER_API_KEY. No implicit provider/model fallback.
--effort none|minimal|low|medium|high|xhigh (provider/model must support it).
--phase-models JSON overrides assess/verify with explicit {provider,model,effort?} objects; legacy plan is accepted but unused.
--max-parallel 1..50 remains accepted for compatibility; a reviewer uses one coherent session.
--log-level quiet|info|debug (default info).
--purpose TEXT supplies caller-stated objective/stage; no inferred objective is treated as approved.
--pr-context PATH supplies bounded, untrusted PR history/discussion data bound to this comparison; never approval or governing instructions.
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
No runtime code execution or hidden reasoning capture. Cancellation preserves accepted work.

GitHub adapter (GITHUB_TOKEN only for confirmed network operations):
github prepare --repository OWNER/REPO --pr-number N --reviewer SKILL_ID --output-dir DIR
  [--base-branch BRANCH] [--collect-pr-context]
github publish --run-dir RUN_DIR --github-dir DIR [--post-comment] [--inline-comments]
  [--summary-file PATH] [--artifact-url URL] [--dry-run]
Dry-run/render-only publication makes no network request. Posting requires pull-requests:write.
`;
function positive(value: string | undefined, flag: string): number | null {
    if (value === undefined) return null;
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
        throw new CliInputError(`${flag} must be a positive safe integer.`);
    return Number(value);
}
class CliInputError extends Error {}

function readArguments() {
    return parseArgs({
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
            'phase-models': { type: 'string' },
            'max-parallel': { type: 'string' },
            'log-level': { type: 'string' },
            repository: { type: 'string' },
            'pr-number': { type: 'string' },
            'output-dir': { type: 'string' },
            'base-branch': { type: 'string' },
            'collect-pr-context': { type: 'boolean' },
            'run-dir': { type: 'string' },
            resume: { type: 'string' },
            'github-dir': { type: 'string' },
            'post-comment': { type: 'boolean' },
            'inline-comments': { type: 'boolean' },
            'summary-file': { type: 'string' },
            'artifact-url': { type: 'string' },
            'dry-run': { type: 'boolean' },
            purpose: { type: 'string' },
            'pr-context': { type: 'string' },
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
}
type CliValues = ReturnType<typeof readArguments>['values'];
type Setting = (flag: string) => string | undefined;
async function runGitHubCommand(values: CliValues, positionals: string[]) {
    if (positionals.length !== 2) throw new CliInputError('Use github prepare or github publish.');
    const token = process.env.GITHUB_TOKEN;
    if (positionals[1] === 'prepare') {
        if (!values.repository || !values['pr-number'] || !values.reviewer || !values['output-dir'])
            throw new CliInputError('github prepare requires repository, pr-number, reviewer and output-dir.');
        const result = await prepareGitHubReview({
            repository: values.repository as string,
            prNumber: positive(values['pr-number'] as string, 'pr-number')!,
            reviewer: values.reviewer as string,
            outputDir: values['output-dir'] as string,
            baseBranch: values['base-branch'] as string | undefined,
            collectPrContext: values['collect-pr-context'] === true,
            token,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    if (positionals[1] === 'publish') {
        if (!values['run-dir'] || !values['github-dir'])
            throw new CliInputError('github publish requires run-dir and github-dir.');
        const result = await publishGitHubReview({
            runDir: values['run-dir'] as string,
            githubDir: values['github-dir'] as string,
            postComment: values['post-comment'] === true,
            inlineComments: values['inline-comments'] === true,
            summaryFile: values['summary-file'] as string | undefined,
            artifactUrl: values['artifact-url'] as string | undefined,
            dryRun: values['dry-run'] === true,
            token,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = result.exitCode;
        return;
    }
    throw new CliInputError('Use github prepare or github publish.');
}
function readProvider(setting: Setting): ProviderConfiguration {
    const p = setting('provider'),
        model = setting('model'),
        effort = setting('effort');
    if (!p || !['openai', 'openrouter'].includes(p) || !model?.trim())
        throw new CliInputError('review requires explicit --provider openai|openrouter and --model (or environment).');
    if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort))
        throw new CliInputError('Invalid --effort. See --help.');
    return {
        provider: p as ProviderConfiguration['provider'],
        model,
        ...(effort ? { effort: effort as ProviderConfiguration['effort'] } : {}),
    };
}
function readPhaseModel(config: object): ProviderConfiguration {
    const value = config as Record<string, unknown>;
    if (
        Object.keys(value).some((key) => !['provider', 'model', 'effort'].includes(key)) ||
        !['openai', 'openrouter'].includes(String(value.provider)) ||
        typeof value.model !== 'string' ||
        !value.model.trim() ||
        (value.effort !== undefined &&
            !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(value.effort)))
    )
        throw new Error();
    return {
        provider: value.provider as ProviderConfiguration['provider'],
        model: value.model,
        ...(value.effort === undefined ? {} : { effort: value.effort as ProviderConfiguration['effort'] }),
    };
}
function readPhaseModels(input: string | undefined) {
    const phaseModels: Partial<Record<'plan' | 'assess' | 'verify', ProviderConfiguration>> = {};
    if (!input) return phaseModels;
    try {
        const parsed: unknown = JSON.parse(input);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        for (const [phase, config] of Object.entries(parsed)) {
            if (!['plan', 'assess', 'verify'].includes(phase) || !config || typeof config !== 'object')
                throw new Error();
            phaseModels[phase as keyof typeof phaseModels] = readPhaseModel(config);
        }
    } catch {
        throw new CliInputError(
            'phase-models must contain only plan/assess/verify provider/model/optional effort objects.',
        );
    }
    return phaseModels;
}
function readLimits(setting: Setting) {
    const limits: ExecutionLimits = { ...DEFAULT_EXECUTION_LIMITS };
    const sourceLimits: Partial<SourceLimits> = {};
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
    return { limits, sourceLimits };
}
function readPolicy(values: CliValues, setting: Setting): ReviewPolicy {
    const policy: ReviewPolicy = {
        minAdherence: null,
        minConfidence: null,
        advisory: (values.advisory as boolean | undefined) ?? process.env.CONTEXTRAIL_REVIEW_ADVISORY === 'true',
    };
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
    return policy;
}
function commandSettings(values: CliValues, isReview: boolean) {
    const setting = (flag: string) =>
        ((values as Record<string, string | boolean | undefined>)[flag] as string | undefined) ??
        process.env[`CONTEXTRAIL_REVIEW_${flag.toUpperCase().replaceAll('-', '_')}`];
    const resumePath = setting('resume');
    if (resumePath && !isReview) throw new CliInputError('--resume is only valid for review.');
    const feedback = setting('feedback') ?? 'send';
    if (!['send', 'off'].includes(feedback)) throw new CliInputError('feedback must be send or off.');
    const repositorySetting = process.env.CONTEXTRAIL_REVIEW_REPOSITORY_ATTRIBUTION;
    if (repositorySetting !== undefined && !['true', 'false'].includes(repositorySetting))
        throw new CliInputError('repository attribution must be true or false.');
    const repositoryAttribution =
        (values['repository-attribution'] as boolean | undefined) ?? repositorySetting === 'true';
    const defaults = {
        provider: undefined as ProviderConfiguration | undefined,
        phaseModels: {} as Partial<Record<'plan' | 'assess' | 'verify', ProviderConfiguration>>,
        maxParallel: 3,
        logLevel: 'info' as 'quiet' | 'info' | 'debug',
        limits: { ...DEFAULT_EXECUTION_LIMITS },
        sourceLimits: {} as Partial<SourceLimits>,
        policy: {
            minAdherence: null,
            minConfidence: null,
            advisory: (values.advisory as boolean | undefined) ?? process.env.CONTEXTRAIL_REVIEW_ADVISORY === 'true',
        } as ReviewPolicy,
    };
    if (!isReview) return { setting, resumePath, feedback, repositoryAttribution, ...defaults };
    const provider = readProvider(setting);
    const phaseModels = readPhaseModels(setting('phase-models'));
    const maxParallel = positive(setting('max-parallel'), 'max-parallel') ?? 3;
    if (maxParallel > 50) throw new CliInputError('max-parallel must be 1..50.');
    const level = setting('log-level') ?? 'info';
    if (!['quiet', 'info', 'debug'].includes(level)) throw new CliInputError('Invalid log-level.');
    const logLevel = level as typeof defaults.logLevel;
    const limits = readLimits(setting);
    const policy = readPolicy(values, setting);
    return {
        setting,
        resumePath,
        feedback,
        repositoryAttribution,
        provider,
        phaseModels,
        maxParallel,
        logLevel,
        ...limits,
        policy,
    };
}
function commandComparison(values: CliValues, isReview: boolean, setting: Setting) {
    if (!(values.reviewer as string).startsWith('skill://'))
        throw new CliInputError('--reviewer must be a skill:// ID.');
    let artifact;
    try {
        artifact = fixGitIdentity(values.repo as string, values.base as string, values.head as string);
    } catch {
        throw new CliInputError('Cannot resolve repository and base/head references to Git commits.');
    }
    let prContext;
    const prContextPath = setting('pr-context');
    if (isReview && prContextPath) {
        try {
            prContext = loadPrContext(prContextPath, artifact, values.reviewer as string);
        } catch {
            throw new CliInputError('Invalid or oversized --pr-context file, or mismatched comparison/reviewer.');
        }
    }
    return { artifact, prContext };
}
let commandStage = 'arguments';
async function runCommand(values: CliValues, isReview: boolean) {
    commandStage = 'configuration';
    const {
        setting,
        resumePath,
        feedback,
        repositoryAttribution,
        provider,
        phaseModels,
        maxParallel,
        logLevel,
        limits,
        sourceLimits,
        policy,
    } = commandSettings(values, isReview);
    const timeoutMs = mcpTimeoutMs(
        (values['mcp-timeout-ms'] as string | undefined) ?? process.env.CONTEXTRAIL_MCP_TIMEOUT_MS,
    );
    commandStage = 'comparison';
    const { artifact, prContext } = commandComparison(values, isReview, setting);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    commandStage = 'mcp_configuration';
    const reader = new McpPublishedReader(
        process.env.CONTEXTRAIL_MCP_URL ?? '',
        process.env.CONTEXTRAIL_MCP_AUTH_TOKEN ?? '',
        process.env.CONTEXTRAIL_MCP_ORG_ID ?? '',
        artifact.repositoryEnvironment,
        { timeoutMs, signal: controller.signal, repositoryAttribution },
    );
    try {
        commandStage = resumePath ? 'resume' : 'preparation';
        const resumed = resumePath
            ? loadReviewCheckpoint(resumePath, {
                  artifact,
                  reviewerId: values.reviewer as string,
              })
            : null;
        commandStage = 'preparation';
        const prepared =
            resumed?.prepared ??
            (await prepareReview({
                repository: values.repo as string,
                base: values.base as string,
                head: values.head as string,
                reviewerId: values.reviewer as string,
                reader,
                artifact,
            }));
        if (isReview) {
            commandStage = 'review';
            const result = await runReview({
                prepared,
                resume: resumed?.checkpoint,
                provider: provider!,
                phaseModels,
                maxParallel,
                logLevel,
                policy,
                limits,
                sourceLimits,
                feedback: feedback as 'send' | 'off',
                feedbackSender: reader,
                repositoryAttribution,
                purpose: setting('purpose'),
                prContext,
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
async function main() {
    const { values, positionals } = readArguments();
    if (values.help) {
        process.stdout.write(help);
        return;
    }
    if (values.version) {
        process.stdout.write(`${packageVersion}\n`);
        return;
    }
    if (positionals[0] === 'github') {
        commandStage = 'github';
        return runGitHubCommand(values, positionals);
    }
    if (
        positionals.length !== 1 ||
        !['prepare', 'review'].includes(positionals[0]!) ||
        !values.reviewer ||
        !values.base ||
        !values.head
    )
        throw new CliInputError('Use prepare or review with --reviewer, --base and --head. See --help.');
    await runCommand(values, positionals[0] === 'review');
}

function commandFailure(error: unknown) {
    const { systemCode } = systemFailureDiagnostics(error);
    if (systemCode) return { code: systemCode };
    const transport = providerTransportDiagnostics(error);
    if (transport.transport !== 'unknown') return { code: 'transport_failed', ...transport };
    return { code: commandStage === 'mcp_configuration' ? 'invalid_mcp_configuration' : 'command_failed' };
}
main().catch((error: unknown) => {
    process.stderr.write(
        error instanceof CliInputError
            ? `${error.message}\n`
            : `${JSON.stringify({ kind: 'cli_failed', data: { stage: commandStage, ...commandFailure(error) } })}\n`,
    );
    process.exitCode = 2;
});
