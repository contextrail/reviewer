import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { assessmentCoverage } from './presentation.js';
import { parsePrContext, type PrContext } from './pr-context.js';
import { sendReviewReport, type ReportingStatus, type ReviewFeedbackSender } from './feedback.js';
import { atomicJson, digest, structuredRequirements, type PreparedState } from './prepare.js';
import { CitationError, EvidenceLedger, modelEvidence, resolveCitationSelections } from './evidence.js';
import { DEFAULT_POLICY, decideExit, type ReviewEntry, type AcceptedResult, type ReviewPolicy } from './results.js';
import {
    reviewModel,
    ProviderAccountingError,
    recoverProviderCalls,
    reportedUsage,
    providerFailureDiagnostics,
    providerResponseDiagnostics,
    providerRequestDiagnostics,
    providerTransportDiagnostics,
    type ProviderConfiguration,
    type ReviewProvider,
    type ProviderFailureCode,
} from './providers.js';
import { FixedSnapshotSource, SourceAccessError, type SourceLimits } from './source.js';
import { publicationSchema, type Publication } from './contracts.js';
import { createPhaseRecord, validatePhaseRecord, type PhaseRecord } from './phases.js';
import { ReviewBudget, BudgetStop, DEFAULT_EXECUTION_LIMITS, type ExecutionLimits, type ModelPhase } from './budget.js';
import {
    Diagnostics,
    sanitizeRecord,
    systemFailureDiagnostics,
    submissionDiagnostics,
    submissionToolDiagnostics,
    type LogLevel,
} from './diagnostics.js';
import { exactIds, PlanCitationError } from './planning.js';
import { loadReviewCheckpoint, type ReviewCheckpoint } from './resume.js';
import { prepareEvidencePack, writeEvidencePack, readPackPublication } from './pack.js';
import {
    reviewSelectionSchema,
    ReviewAccumulator,
    revalidateProposal,
    reconcileFindings,
    assessmentInstructions,
    type AssessmentProposal,
    type CheckAssessment,
    type ReviewFinding,
} from './assessment.js';
import {
    verificationSelectionSchema,
    validateVerification,
    verificationInstructions,
    type VerificationEntry,
} from './verification.js';
export { DEFAULT_EXECUTION_LIMITS, type ExecutionLimits };
export type ReviewState = Omit<PreparedState, 'schemaVersion' | 'entries' | 'reviewStatus'> & {
    schemaVersion: 2;
    entries: ReviewEntry[];
    reviewStatus: 'running' | 'complete' | 'incomplete';
    phases: PhaseRecord[];
    checks: CheckAssessment[];
    findings: ReviewFinding[];
    verification: { expected: number; verified: number; complete: boolean };
    execution: {
        requested: ProviderConfiguration;
        phaseModels: Record<ModelPhase, ProviderConfiguration>;
        limits: ExecutionLimits;
        sourceLimits: Readonly<SourceLimits>;
        policy: ReviewPolicy;
        rubric: { adherence: 'adherence-v1'; confidence: 'model-confidence-v1' };
        purpose: string | null;
        prContext: {
            hash: string;
            capturedAt: string;
            discussion: string;
            historyRuns: number;
            previousHead: string | null;
        } | null;
        scope: string | null;
        startedAt: string;
        elapsedMs: number;
        calls: number;
        steps: number;
        stopReason: string | null;
        usage: Array<Record<string, unknown>>;
        providerUsage: Array<{
            call: number;
            provider: ReviewProvider;
            phase: ModelPhase;
            workUnitId: string;
            usage: unknown;
            missing: boolean;
            httpStatus?: number;
            failureCode?: ProviderFailureCode;
        }>;
        returnedIdentities: Array<{ provider: string | null; model: string | null }>;
        reporting: ReportingStatus;
        capture: string;
        reservedTurns: number;
        maxParallel: number;
        logLevel: LogLevel;
    };
    decision: ReturnType<typeof decideExit> | null;
};
const phaseOverridesSchema = z.strictObject({
    plan: z.unknown().optional(),
    assess: z.unknown().optional(),
    verify: z.unknown().optional(),
});
const providerSchema = z.strictObject({
    provider: z.enum(['openai', 'openrouter']),
    model: z.string().min(1),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
});
function phaseConfiguration(defaults: ProviderConfiguration, overrides: unknown = {}) {
    const base = providerSchema.parse(defaults),
        parsed = phaseOverridesSchema.parse(overrides);
    return Object.fromEntries(
        (['plan', 'assess', 'verify'] as const).map((p) => [
            p,
            parsed[p] === undefined ? base : providerSchema.parse(parsed[p]),
        ]),
    ) as Record<ModelPhase, ProviderConfiguration>;
}
const sourceSide = z.enum(['base', 'head']);
const integer = z.number().int().nonnegative().optional();
const sensitivePath = (path: string) =>
    path
        .split('/')
        .some((part) => /^\.env(?:\.|$)|^(?:credentials|secrets)(?:\.|$)|\.(?:pem|key|p12|pfx)$/iu.test(part));
const phaseFilename = (phase: string, unit: string, attempt: number) =>
    phase === 'plan' && unit === 'all' && attempt === 1 ? 'plan.json' : `${phase}-${unit}-${attempt}.json`;
const requireRuntime = createRequire(import.meta.url);
const runtimeVersion = (name: string) => {
    try {
        return (
            JSON.parse(readFileSync(join(dirname(requireRuntime.resolve(name)), '..', 'package.json'), 'utf8')) as {
                version: string;
            }
        ).version;
    } catch {
        return 'unavailable';
    }
};
const cleanIdentity = (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9._:/+-]{1,200}$/u.test(value) ? value : null;
function normalizedWireUsage(raw: unknown) {
    if (!raw || typeof raw !== 'object') return null;
    const allow = [
        'input_tokens',
        'output_tokens',
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        'cost',
        'input_tokens_details',
        'output_tokens_details',
        'prompt_tokens_details',
        'completion_tokens_details',
    ];
    return Object.fromEntries(
        Object.entries(raw)
            .filter(([key]) => allow.includes(key))
            .map(([key, value]) => [
                key,
                value && typeof value === 'object'
                    ? Object.fromEntries(
                          Object.entries(value).filter(
                              ([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
                          ),
                      )
                    : typeof value === 'number' && Number.isFinite(value) && value >= 0
                      ? value
                      : null,
            ]),
    );
}
type ReviewOptions = {
    prepared: { state: PreparedState; statePath: string; materialPath: string; manifestPath?: string };
    provider: ProviderConfiguration;
    phaseModels?: Partial<Record<ModelPhase, ProviderConfiguration>>;
    maxParallel?: number;
    logLevel?: LogLevel;
    policy?: Partial<ReviewPolicy>;
    limits?: Partial<ExecutionLimits>;
    sourceLimits?: Partial<SourceLimits>;
    purpose?: string;
    prContext?: PrContext;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    feedback?: 'send' | 'off';
    feedbackSender?: ReviewFeedbackSender;
    repositoryAttribution?: boolean;
    resume?: ReviewCheckpoint;
};
function initialReviewState(
    options: ReviewOptions,
    source: FixedSnapshotSource,
    budget: ReviewBudget,
    prContext: PrContext | null,
    settings: {
        models: Record<ModelPhase, ProviderConfiguration>;
        maxParallel: number;
        logLevel: LogLevel;
        limits: ExecutionLimits;
    },
): ReviewState {
    const { prepared } = options,
        { models, maxParallel, logLevel, limits } = settings;
    return {
        ...structuredClone(prepared.state),
        schemaVersion: 2,
        entries: structuredClone(prepared.state.entries),
        reviewStatus: 'running',
        phases: [],
        checks: [],
        findings: [],
        verification: { expected: prepared.state.entries.length, verified: 0, complete: false },
        decision: null,
        limitations: prepared.state.limitations
            .filter((v) => !v.startsWith('Prepared means'))
            .concat(
                'No runtime code was executed. Exact citations and accounting do not prove interpretation correctness or exhaustive review.',
            ),
        execution: {
            requested: options.provider,
            phaseModels: models,
            limits,
            sourceLimits: source.limits,
            policy: { ...DEFAULT_POLICY, ...options.policy },
            rubric: { adherence: 'adherence-v1', confidence: 'model-confidence-v1' },
            purpose: options.purpose ?? null,
            prContext: prContext
                ? {
                      hash: digest(sanitizeRecord(prContext)),
                      capturedAt: prContext.capturedAt,
                      discussion: prContext.discussion.status,
                      historyRuns: prContext.history.runs.length,
                      previousHead: prContext.history.assessment?.head ?? null,
                  }
                : null,
            scope: null,
            startedAt: new Date().toISOString(),
            elapsedMs: 0,
            calls: 0,
            steps: 0,
            stopReason: null,
            usage: [],
            providerUsage: [],
            returnedIdentities: [],
            reporting: { status: 'pending' },
            capture:
                'Bounded phase assessment artifacts and safe diagnostic metadata. No raw prompt/response conversations, headers, error bodies or hidden reasoning. Caller-managed access and retention.',
            reservedTurns: budget.reservedTurns,
            maxParallel,
            logLevel,
        },
    };
}
function restoreCheckpoint(options: ReviewOptions, directory: string, state: ReviewState, ledger: EvidenceLedger) {
    const { prepared } = options;
    if (options.resume) {
        const loaded = loadReviewCheckpoint(directory, {
            artifact: prepared.state.artifact,
            reviewerId: prepared.state.requestedReviewerId,
        });
        if (
            digest(loaded.checkpoint) !== digest(options.resume) ||
            digest(loaded.prepared.state) !== digest(prepared.state)
        )
            throw new Error('resume_checkpoint_changed');
        const old = options.resume.state;
        if (
            old.runId !== state.runId ||
            digest(old.artifact) !== digest(state.artifact) ||
            old.scopeIdentity !== state.scopeIdentity ||
            digest(old.execution.phaseModels) !== digest(state.execution.phaseModels) ||
            digest(old.execution.sourceLimits) !== digest(state.execution.sourceLimits) ||
            digest(old.execution.policy) !== digest(state.execution.policy) ||
            old.execution.purpose !== state.execution.purpose ||
            old.execution.prContext?.hash !== state.execution.prContext?.hash
        )
            throw new Error('resume_configuration_changed');
        state.phases = structuredClone(old.phases);
        state.execution.usage = structuredClone(old.execution.usage);
        state.execution.providerUsage = structuredClone(old.execution.providerUsage);
        state.execution.returnedIdentities = structuredClone(old.execution.returnedIdentities);
        state.execution.calls = old.execution.calls;
        state.execution.steps = old.execution.steps;
        for (const record of Object.values(options.resume.evidence))
            ledger.add(record.text, record.provenance, record.fragments);
    }
}
async function restorePreparationManifest(
    options: ReviewOptions,
    state: ReviewState,
    directory: string,
    material: Record<string, Publication>,
    ledger: EvidenceLedger,
    preparedManifest: unknown,
) {
    if (options.resume) {
        const structured = Object.fromEntries(
            Object.entries(material).map(([id, p]) => [id, structuredRequirements(p)]),
        );
        const latest = state.phases.filter((p) => p.phase === 'assess' && p.workUnitId === 'all').at(-1);
        if (latest?.status === 'complete')
            for (const p of latest.output as AssessmentProposal[])
                revalidateProposal(p, state.entries, ledger, structured);
        else if (latest) {
            const partial = JSON.parse(
                await readFile(join(directory, 'phases', `partial-assess-all-${latest.attempt}.json`), 'utf8').catch(
                    () => 'null',
                ),
            );
            if (partial)
                for (const p of (partial.output as { assessments: AssessmentProposal[] }).assessments)
                    revalidateProposal(p, state.entries, ledger, structured);
        }
        await atomicJson(join(directory, 'manifest.json'), preparedManifest);
    }
}
async function createReviewRuntime(options: ReviewOptions) {
    const { prepared } = options,
        directory = dirname(prepared.statePath),
        source = new FixedSnapshotSource(prepared.state.artifact, options.sourceLimits);
    const models = phaseConfiguration(options.provider, options.phaseModels),
        maxParallel = options.maxParallel ?? 3,
        logLevel = options.logLevel ?? 'info';
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 50) throw new Error('invalid_max_parallel');
    if (!['quiet', 'info', 'debug'].includes(logLevel)) throw new Error('invalid_log_level');
    const limits = { ...DEFAULT_EXECUTION_LIMITS, ...options.limits },
        budget = new ReviewBudget(limits);
    const prContext = options.prContext
        ? parsePrContext(
              options.prContext,
              prepared.state.artifact,
              prepared.state.reviewer?.nodeId ?? options.prContext.reviewer,
          )
        : null;
    const state = initialReviewState(options, source, budget, prContext, { models, maxParallel, logLevel, limits });
    const diagnostics = new Diagnostics(directory, state.runId, logLevel),
        ledger = new EvidenceLedger();
    restoreCheckpoint(options, directory, state, ledger);
    const invocationPhaseIndex = state.phases.length;
    const previousCalls = state.execution.calls,
        previousElapsed = options.resume?.state.execution.elapsedMs ?? 0;

    await mkdir(join(directory, 'phases'), { recursive: true, mode: 0o700 });
    let writes = Promise.resolve();
    const persist = () => {
        const next = writes.then(async () => {
            await atomicJson(join(directory, 'evidence.json'), sanitizeRecord(ledger.records));
            await atomicJson(prepared.statePath, sanitizeRecord(state));
        });
        writes = next.catch(() => undefined);
        return next;
    };
    const material = JSON.parse(await readFile(prepared.materialPath, 'utf8')) as Record<string, Publication>;
    const preparedManifest =
        options.resume?.preparationManifest ?? JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    await restorePreparationManifest(options, state, directory, material, ledger, preparedManifest);
    const manifestHash = digest(preparedManifest),
        materialHash = digest(material);
    return {
        options,
        prepared,
        prContext,
        directory,
        source,
        models,
        limits,
        budget,
        state,
        ledger,
        diagnostics,
        persist,
        material,
        preparedManifest,
        manifestHash,
        materialHash,
        invocationPhaseIndex,
        previousCalls,
        previousElapsed,
        evidencePack: undefined as ReturnType<typeof prepareEvidencePack> | undefined,
        retainedProposals: [] as AssessmentProposal[],
    };
}
type ReviewRuntime = Awaited<ReturnType<typeof createReviewRuntime>>;
type PhaseRuntime<T> = {
    run: ReviewRuntime;
    phase: 'assess' | 'verify';
    workUnitId: string;
    assigned: ReviewEntry[];
    payload: unknown;
    schema: z.ZodType;
    validate: (value: unknown) => T;
    attempt: number;
    startedAt: string;
    inputRefs: PhaseRecord['inputRefs'];
    phaseCalls: number[];
    timer: ReturnType<typeof setTimeout> | null;
    signal: AbortSignal;
    instructions: string;
    assessmentAccumulator: ReviewAccumulator | null;
    output: T | undefined;
    sdkStop: string | null;
    rejected: number;
    stepRejected: boolean;
    assessmentWrites: Promise<void>;
};
const correctionRounds = <T>(session: PhaseRuntime<T>) => session.rejected + Number(session.stepRejected);
async function createPhaseRuntime<T>(
    run: ReviewRuntime,
    phase: 'assess' | 'verify',
    workUnitId: string,
    assigned: ReviewEntry[],
    payload: unknown,
    schema: z.ZodType,
    validate: (value: unknown) => T,
    attempt = 1,
): Promise<PhaseRuntime<T>> {
    const {
        state,
        directory,
        budget,
        ledger,
        options,
        material,
        manifestHash,
        materialHash,
        retainedProposals,
        prepared,
    } = run;

    const startedAt = new Date().toISOString(),
        inputRefs = [
            { ref: 'manifest.json', hash: manifestHash },
            { ref: 'publications.json', hash: materialHash },
            ...state.phases
                .filter((p) => p.status === 'complete')
                .map((p) => ({ ref: `phase:${p.phase}:${p.workUnitId}:${p.attempt}`, hash: digest(p) })),
            { ref: `input:${phase}:${workUnitId}:${attempt}`, hash: digest(sanitizeRecord(payload)) },
        ],
        phaseCalls: number[] = [];
    if (
        digest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))) !== manifestHash ||
        digest(JSON.parse(await readFile(prepared.materialPath, 'utf8'))) !== materialHash
    )
        throw new Error('upstream_artifact_changed');
    for (const p of state.phases.filter((p) => p.status === 'complete')) {
        const name = phaseFilename(p.phase, p.workUnitId, p.attempt);
        if (digest(JSON.parse(await readFile(join(directory, 'phases', name), 'utf8'))) !== digest(p))
            throw new Error('upstream_phase_changed');
    }
    const remaining = budget.remainingMs(phase),
        controller = new AbortController();
    if (remaining !== null && remaining <= 0)
        throw new BudgetStop(phase === 'verify' ? 'max_time_ms' : 'verification_time_reserved');
    const timer = remaining === null ? null : setTimeout(() => controller.abort(), Math.max(1, remaining));
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let output: T | undefined;
    const instructions = {
        assess: assessmentInstructions,
        verify: verificationInstructions,
    }[phase];
    const assessmentAccumulator =
        phase === 'assess'
            ? new ReviewAccumulator(
                  assigned,
                  ledger,
                  Object.fromEntries(Object.entries(material).map(([id, p]) => [id, structuredRequirements(p)])),
                  retainedProposals,
              )
            : null;
    if (assessmentAccumulator?.remaining().length === 0) output = assessmentAccumulator.snapshot() as T;
    return {
        run,
        phase,
        workUnitId,
        assigned,
        payload,
        schema,
        validate,
        attempt,
        startedAt,
        inputRefs,
        phaseCalls,
        timer,
        signal,
        instructions,
        assessmentAccumulator,
        output,
        sdkStop: null,
        rejected: 0,
        stepRejected: false,
        assessmentWrites: Promise.resolve(),
    };
}
async function persistPartialAssessment<T>(session: PhaseRuntime<T>, progress: { remaining: string[] }) {
    const {
        run,
        workUnitId,
        assigned,
        attempt,
        startedAt,
        inputRefs,
        phaseCalls,
        instructions,
        assessmentAccumulator,
    } = session;
    const { state, directory, ledger, models } = run;

    if (!assessmentAccumulator) return;
    const record = createPhaseRecord({
        runId: state.runId,
        phase: 'assess',
        workUnitId,
        attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'incomplete',
        inputRefs,
        artifact: state.artifact,
        scopeIdentity: state.scopeIdentity,
        assessmentIds: assigned.map((entry) => entry.assessmentId),
        evidenceRefs: Object.keys(ledger.records),
        limitations: [
            'Retained proposals are not final judgments; complete group handoff and independent verification remain required.',
        ],
        stopReason: progress.remaining.length ? 'awaiting_assessment_entries' : 'awaiting_assessment_handoff',
        configuration: {
            provider: models.assess.provider,
            model: models.assess.model,
            promptHash: digest(instructions),
            kind: 'partial_assessment_progress',
        },
        usageRefs: phaseCalls.map((call) => `call:${call}`),
        output: { assessments: assessmentAccumulator.snapshot(), remaining: progress.remaining },
    });
    const operation = session.assessmentWrites.then(() =>
        atomicJson(join(directory, 'phases', `partial-assess-${workUnitId}-${attempt}.json`), sanitizeRecord(record)),
    );
    session.assessmentWrites = operation.catch(() => undefined);
    await operation;
}
async function invokeTool<T, ToolResult>(session: PhaseRuntime<T>, name: string, body: () => Promise<ToolResult>) {
    const { run, phase, workUnitId, attempt, signal } = session;
    const { diagnostics } = run;
    const started = performance.now();

    await diagnostics.event('tool_started', { phase, workUnitId, attempt, tool: name });
    try {
        signal.throwIfAborted();
        const result = await body();
        await diagnostics.event('tool_completed', {
            phase,
            workUnitId,
            attempt,
            tool: name,
            elapsedMs: performance.now() - started,
        });
        return result;
    } catch (error) {
        await diagnostics.event('tool_failed', {
            phase,
            workUnitId,
            attempt,
            tool: name,
            code:
                error instanceof SourceAccessError
                    ? error.code
                    : signal.aborted
                      ? 'cancelled'
                      : 'tool_execution_failed',
            elapsedMs: performance.now() - started,
            details: { ...providerFailureDiagnostics(error), ...systemFailureDiagnostics(error) },
        });
        if (error instanceof SourceAccessError) {
            return {
                error: error.code,
                correction:
                    name === 'search_source'
                        ? 'path must name one exact committed file, not a directory or glob. Locate it with changedFiles/list_source, or omit path for a bounded tree search. Use the exact returned cursor for continuation. No complete evidence returned.'
                        : 'Check pinned path/side/range and use exact returned continuation. No complete evidence returned.',
            };
        }
        throw error;
    }
}
function submissionCorrection(error: unknown, code: string) {
    const planCorrection =
        error instanceof PlanCitationError
            ? {
                  message:
                      'Correct every listed governing citation in one resubmission. Use an exact allowed ref only for its canonical assessment/context/version, and select a valid inclusive numbered segment range from that original governing material. Do not substitute another context, invent a ref, or alter governing scope.',
                  invalidCitations: error.corrections,
                  omittedCount: error.omittedCount,
              }
            : null;
    return (
        (error instanceof CitationError
            ? {
                  message: error.message,
                  path: error.path,
                  ref: error.ref,
                  refHash: error.refHash,
                  instruction:
                      'Correct this exact citation field. Use the ref returned with the relevant pinned guidance or source read and choose valid displayed startSegment/endSegment indices, inclusive and relative to that evidence record. Read a narrower source range if needed. Code extracts the quotation. Do not invent a reference, provide quote text, or change the assessment to evade validation.',
              }
            : planCorrection) ??
        (code === 'verification_acceptance_inconsistent'
            ? 'Accept means the assessment is supported, including an assessment proving code violations. Supported violation findings need accepted=true. If any finding is unsupported or missingChecks is nonempty, use revise/reject/unresolved for the context instead of accept; otherwise missingChecks must be empty.'
            : code === 'unproposed_suggestion_acceptance'
              ? 'Set suggestionAccepted=false unless this exact finding contains a non-null proposedReplacement object that you independently checked. A prose correction is not a patch. A supported finding can have accepted=true and suggestionAccepted=false.'
              : error instanceof z.ZodError
                ? error.issues.map((i) => ({
                      code: i.code,
                      path: i.path.map((p) => (typeof p === 'number' ? p : '[field]')),
                  }))
                : error instanceof Error
                  ? error.message
                  : 'Invalid submission')
    );
}
async function rejectSubmission<T>(session: PhaseRuntime<T>, rawInput: unknown, error: unknown) {
    const { run, phase, workUnitId, attempt, assessmentAccumulator } = session;
    const { diagnostics } = run;

    session.stepRejected = true;
    const { code: diagnosticCode, details } = submissionDiagnostics(error);
    const code = error instanceof PlanCitationError ? error.code : diagnosticCode;
    await diagnostics.event('submission_rejected', {
        phase,
        workUnitId,
        attempt,
        code,
        details,
        ...(assessmentAccumulator ? { remaining: assessmentAccumulator.remaining() } : {}),
        ...(error instanceof PlanCitationError
            ? {
                  corrections: error.corrections.map((c) => ({
                      assessmentId: c.assessmentId,
                      entryIndex: c.entryIndex,
                      checkIndex: c.checkIndex,
                      code: c.code,
                      rejectedRefHash: c.rejectedRefHash,
                      allowedRefCount: c.allowedRefs.length,
                  })),
                  omittedCount: error.omittedCount,
              }
            : {}),
        outputHash: digest(rawInput ?? null),
        count: correctionRounds(session),
    });
    return {
        accepted: false,
        code,
        ...(assessmentAccumulator
            ? {
                  remaining: assessmentAccumulator.remaining(),
                  instruction:
                      'Submit exactly one remaining canonical context per tool call; accepted proposals are retained and cannot be overwritten.',
              }
            : {}),
        correction: submissionCorrection(error, code),
        remainingCorrections: Math.max(0, 3 - correctionRounds(session)),
    };
}
async function submitPhaseOutput<T>(session: PhaseRuntime<T>, rawInput: unknown) {
    const { run, phase, workUnitId, assigned, schema, validate, attempt, signal, assessmentAccumulator } = session;
    const { diagnostics, ledger } = run;
    try {
        signal.throwIfAborted();
        const selectedInput = schema.parse(rawInput);
        if (session.output !== undefined && !assessmentAccumulator) throw new Error('phase_already_submitted');
        const input = resolveCitationSelections(selectedInput, ledger);
        if (assessmentAccumulator) {
            const progress = assessmentAccumulator.submit(input);
            await persistPartialAssessment(session, progress);
            if (progress.complete) {
                const proposals = assessmentAccumulator.snapshot();
                exactIds(
                    proposals.map((p) => p.result.assessmentId),
                    assigned.map((entry) => entry.assessmentId),
                );
                session.output = proposals as T;
            }
            await diagnostics.event('assessment_progress', {
                phase,
                workUnitId,
                attempt,
                newlyAccepted: progress.newlyAccepted,
                alreadyAccepted: progress.alreadyAccepted,
                remaining: progress.remaining,
            });
            if (progress.complete)
                await diagnostics.event('submission_accepted', {
                    phase,
                    workUnitId,
                    attempt,
                    outputHash: digest(session.output),
                });
            return {
                accepted: true,
                ...progress,
                remainingCorrections: Math.max(0, 3 - correctionRounds(session)),
            };
        }
        session.output = validate(input);
        await diagnostics.event('submission_accepted', {
            phase,
            workUnitId,
            attempt,
            outputHash: digest(session.output),
        });
        return { accepted: true };
    } catch (error) {
        return rejectSubmission(session, rawInput, error);
    }
}
function sourceTools<T>(session: PhaseRuntime<T>) {
    const { run, phase, workUnitId, attempt, signal } = session;
    const { source, ledger, persist, diagnostics } = run;
    const invoke = <R>(name: string, body: () => Promise<R>) => invokeTool(session, name, body);
    return {
        changes: tool({
            strict: false,
            description:
                'Changed-file metadata only, not patch text or assessment proof. The prepared changedFiles inventory is complete when labelled complete. Each item.offset opens that file directly with diff({offset, patchLineOffset:0}); metadata paths alone do not establish applicability.',
            inputSchema: z.object({ offset: integer, detectRenames: z.boolean().optional() }),
            execute: (input) => invoke('changes', () => source.changes(input, { signal })),
        }),
        diff: tool({
            strict: false,
            description:
                'Ordinary unified diff text with fixed file identities and continuations. Start at an item.offset from changedFiles/changes to inspect a selected file. Follow next when present; source-side reads provide citation evidence.',
            inputSchema: z.object({
                offset: integer,
                patchLineOffset: integer,
                detectRenames: z.boolean().optional(),
            }),
            execute: (input) => invoke('diff', () => source.diff(input, { signal })),
        }),
        list_source: tool({
            strict: false,
            description: 'List fixed snapshot source paths. Supporting unchanged source is available.',
            inputSchema: z.object({ side: sourceSide, offset: integer }),
            execute: (input) => invoke('list_source', () => source.list(input, { signal })),
        }),
        search_source: tool({
            strict: false,
            description:
                'Literal source navigation. Optional path is one exact committed file, never a directory or glob; locate it with changedFiles/list_source, or omit path for a bounded tree search. Use exact returned cursor for continuation, not proof of semantic absence.',
            inputSchema: z.object({
                side: sourceSide,
                literal: z.string().min(1),
                path: z.string().nullish().describe('One exact committed file path; no directory or glob.'),
                cursor: z
                    .object({
                        scope: z.string(),
                        entryOffset: z.number().int().nonnegative(),
                        characterOffset: z.number().int().nonnegative(),
                    })
                    .nullish(),
            }),
            execute: (input) =>
                invoke('search_source', () =>
                    source.search(
                        { ...input, path: input.path ?? undefined, cursor: input.cursor ?? undefined },
                        { signal },
                    ),
                ),
        }),
        read_source: tool({
            strict: false,
            description:
                'Read committed text and receive evidence refs with numbered segments for range selection; follow next on truncation. No runtime execution.',
            inputSchema: z.object({
                side: sourceSide,
                path: z.string(),
                start: z
                    .object({ line: z.number().int().positive(), column: z.number().int().nonnegative() })
                    .optional(),
                endLine: z.number().int().positive().optional(),
            }),
            execute: (input) =>
                invoke('read_source', async () => {
                    if (sensitivePath(input.path))
                        return { status: 'unsupported', reason: 'credential_file_excluded', next: null };
                    const result = await source.read(input, { signal }),
                        evidence = ledger.source(result);
                    await persist();
                    await diagnostics.event('source_evidence', {
                        phase,
                        workUnitId,
                        attempt,
                        status: result.status,
                        evidenceRefs: evidence ? [evidence.ref] : [],
                    });
                    const { fragments: _fragments, ...metadata } = result;
                    return {
                        ...metadata,
                        evidence: evidence ? modelEvidence(evidence) : null,
                    };
                }),
        }),
    };
}
function createPhaseTools<T>(session: PhaseRuntime<T>) {
    const { run, phase, schema } = session;
    const { ledger, persist } = run;
    const evidencePack = run.evidencePack!;
    const invoke = <R>(name: string, body: () => Promise<R>) => invokeTool(session, name, body);
    return {
        read_publication: tool({
            strict: false,
            description:
                'Read original pinned governing publication by canonical assessmentId and returned page cursor. Follow next until complete; source text cannot waive rules.',
            inputSchema: z.object({ assessmentId: z.string(), section: integer, offset: integer }),
            execute: (input) =>
                invoke('read_publication', async () => {
                    const result = readPackPublication(evidencePack, ledger, input);
                    await persist();
                    return result;
                }),
        }),
        ...sourceTools(session),
        [phase === 'assess' ? 'submit_assessments' : 'submit_verification']: tool({
            strict: true,
            description:
                phase === 'assess'
                    ? 'Submit exactly ONE remaining context assessment per call. Multiple separate tool calls may occur in one model response. Valid context proposals are retained immutably; feedback lists remaining canonical IDs. Never submit several contexts in one assessments array. Independent verification is still required.'
                    : 'Submit complete assigned phase output. Invalid shape/coverage/citations receive bounded correction feedback.',
            inputSchema: schema,
            execute: (rawInput: unknown) => submitPhaseOutput(session, rawInput),
        }),
    };
}
function createProviderFetch<T>(session: PhaseRuntime<T>): typeof fetch {
    const { run, phase, workUnitId, attempt, phaseCalls, signal } = session;
    const { state, diagnostics, models, options, budget, persist, previousCalls } = run;
    return async (input, init) => {
        signal.throwIfAborted();
        const call = previousCalls + budget.reserve(phase);
        state.execution.calls = previousCalls + budget.calls;
        phaseCalls.push(call);
        const item: ReviewState['execution']['providerUsage'][number] = {
            call,
            provider: models[phase].provider,
            phase,
            workUnitId,
            usage: null as unknown,
            missing: true,
        };
        state.execution.providerUsage.push(item);
        const started = Date.now();
        const request = providerRequestDiagnostics(init?.body);
        const context = { phase, workUnitId, attempt, call, request };
        await diagnostics
            .event('provider_started', {
                ...context,
                provider: models[phase].provider,
                model: models[phase].model,
            })
            .catch((error: unknown) => {
                throw new ProviderAccountingError(error);
            });
        let recorded = false;
        try {
            const response = await (options.fetch ?? fetch)(input, init);
            if (!response.ok) {
                budget.record(null);
                recorded = true;
                const details = await providerResponseDiagnostics(response);
                item.httpStatus = response.status;
                item.failureCode = details.code;
                await diagnostics.event('provider_failed', {
                    phase,
                    workUnitId,
                    attempt,
                    call,
                    status: response.status,
                    code: item.failureCode,
                    request,
                    details,
                    elapsedMs: Date.now() - started,
                });
                await persist();
                return response;
            }
            const body = (await response.clone().json()) as Record<string, unknown>;
            item.usage = normalizedWireUsage(body.usage);
            item.missing = item.usage === null;
            const usage = reportedUsage(models[phase].provider, item.usage);
            budget.record(usage.totalTokens);
            recorded = true;
            state.execution.usage.push({
                call,
                phase,
                provider: models[phase].provider,
                ...Object.fromEntries(Object.entries(usage).filter(([key]) => key !== 'raw')),
            });
            state.execution.returnedIdentities.push({
                provider: cleanIdentity(body.provider),
                model: cleanIdentity(body.model),
            });
            await diagnostics.event('provider_completed', {
                phase,
                workUnitId,
                attempt,
                call,
                status: response.status,
                request,
                elapsedMs: Date.now() - started,
                usage: Object.fromEntries(Object.entries(usage).filter(([key]) => key !== 'raw')),
            });
            await persist();
            return response;
        } catch (error) {
            if (!recorded) budget.record(null);
            await diagnostics
                .event(recorded ? 'provider_accounting_failed' : 'provider_failed', {
                    ...context,
                    elapsedMs: Date.now() - started,
                    details: {
                        ...providerFailureDiagnostics(error),
                        ...providerTransportDiagnostics(error),
                        ...systemFailureDiagnostics(error),
                    },
                    code: signal.aborted
                        ? 'cancelled'
                        : recorded
                          ? 'provider_accounting_failed'
                          : 'transport_or_response_invalid',
                })
                .catch(() => undefined);
            throw recorded ? new ProviderAccountingError(error) : error;
        }
    };
}
async function runPhaseModel<T>(session: PhaseRuntime<T>) {
    const { run, phase, workUnitId, payload, attempt, signal, instructions, assessmentAccumulator } = session;
    const { state, diagnostics, models, limits } = run;
    const tools = createPhaseTools(session),
        wire = createProviderFetch(session);
    const configured = reviewModel(models[phase], wire);
    const model = recoverProviderCalls(configured.model, signal, (event, count, error) =>
        diagnostics.event(event, {
            phase,
            workUnitId,
            attempt,
            count,
            call: state.execution.calls,
            retryScope: 'request',
            backoffMs: event === 'provider_retry' ? 250 * 2 ** (count - 1) : 0,
            ...providerFailureDiagnostics(error),
        }),
    );
    signal.throwIfAborted();
    let continuation = 0;
    let messages: import('ai').ModelMessage[] = [{ role: 'user', content: JSON.stringify(sanitizeRecord(payload)) }];
    for (; session.output === undefined;) {
        const generated = await generateText({
            ...configured,
            model,
            system: instructions,
            messages,
            tools,
            maxRetries: 0,
            abortSignal: signal,
            ...(limits.maxOutputTokens === null ? {} : { maxOutputTokens: limits.maxOutputTokens }),
            stopWhen: () => session.output !== undefined || session.rejected >= 3 || session.sdkStop !== null,
            onStepEnd: async (step) => {
                state.execution.steps++;
                await diagnostics.event('sdk_step', {
                    phase,
                    workUnitId,
                    attempt,
                    finishReason: step.finishReason,
                });
                for (const item of step.content)
                    if (item.type === 'tool-error' && item.toolName.startsWith('submit_')) {
                        session.stepRejected = true;
                        await diagnostics.event('submission_rejected', {
                            phase,
                            workUnitId,
                            attempt,
                            ...submissionToolDiagnostics(item, step.toolCalls),
                            ...(assessmentAccumulator ? { remaining: assessmentAccumulator.remaining() } : {}),
                            tool: Object.prototype.hasOwnProperty.call(tools, item.toolName)
                                ? item.toolName
                                : 'unknown_tool',
                            outputHash: digest(item.input ?? null),
                            count: correctionRounds(session),
                        });
                    }
                // Independent tools in one response share one opportunity to
                // receive correction feedback; retain the same bounded rounds.
                if (session.stepRejected) session.rejected++;
                session.stepRejected = false;
                if (step.finishReason === 'length') session.sdkStop = 'per_call_output_limit';
                if (step.warnings?.some((w) => w.type === 'unsupported'))
                    session.sdkStop = 'provider_setting_unsupported';
            },
        });
        if (
            session.output !== undefined ||
            phase !== 'assess' ||
            session.rejected >= 3 ||
            session.sdkStop !== null ||
            continuation >= 2
        )
            break;
        continuation++;
        messages = [
            ...messages,
            ...generated.response.messages,
            {
                role: 'user',
                content: JSON.stringify({
                    instruction:
                        'Continue the same investigation. Submit only unfinished canonical criterion IDs; accepted judgments are immutable. Do not repeat completed work.',
                    remaining: assessmentAccumulator!.remaining(),
                }),
            },
        ];
        await diagnostics.event('assessment_continuation', {
            phase,
            workUnitId,
            attempt,
            count: continuation,
            remaining: assessmentAccumulator!.remaining(),
        });
    }
    signal.throwIfAborted();
    if (session.sdkStop !== null) throw new BudgetStop(session.sdkStop);
    if (session.output === undefined)
        throw new BudgetStop(session.rejected >= 3 ? 'phase_corrections_exhausted' : 'model_stopped');
}
function knownExecutionFailure(error: unknown) {
    const codes = [
        'provider_credential_missing',
        'provider_selection_invalid',
        'provider_model_missing',
        'provider_setting_unsupported',
        'upstream_artifact_changed',
        'upstream_phase_changed',
        'pinned_material_changed',
    ];
    return error instanceof Error && codes.includes(error.message) ? error.message : 'provider_or_execution_failed';
}
function phaseStopReason<T>(session: PhaseRuntime<T>, failure: unknown) {
    if (!failure) return null;
    if (failure instanceof BudgetStop) return failure.code;
    if (session.signal.aborted) {
        if (session.run.options.signal?.aborted) return 'cancelled';
        return session.phase === 'verify' ? 'max_time_ms' : 'verification_time_reserved';
    }
    return knownExecutionFailure(failure);
}
async function persistPhaseResult<T>(session: PhaseRuntime<T>, failure: unknown): Promise<T> {
    const { run, phase, workUnitId, assigned, attempt, startedAt, inputRefs, phaseCalls, signal, instructions } =
        session;
    const { state, directory, ledger, diagnostics, models, persist } = run;
    const record = createPhaseRecord({
        runId: state.runId,
        phase,
        workUnitId,
        attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: failure ? (signal.aborted ? 'cancelled' : 'failed') : 'complete',
        inputRefs,
        artifact: state.artifact,
        scopeIdentity: state.scopeIdentity,
        assessmentIds: assigned.map((e) => e.assessmentId),
        evidenceRefs: Object.keys(ledger.records),
        limitations: [],
        stopReason: phaseStopReason(session, failure),
        configuration: {
            provider: models[phase].provider,
            model: models[phase].model,
            effort: models[phase].effort ?? null,
            promptVersion: 'governed-phase-v2',
            promptHash: digest(instructions),
            sdkVersion: runtimeVersion('ai'),
            adapter: '@ai-sdk/openai',
            adapterVersion: runtimeVersion('@ai-sdk/openai'),
        },
        usageRefs: phaseCalls.map((c) => `call:${c}`),
        output: session.output ?? null,
    });
    const filename = phaseFilename(phase, workUnitId, attempt);
    await atomicJson(join(directory, 'phases', filename), sanitizeRecord(record));
    state.phases.push(record);
    await persist();
    if (failure) throw failure;
    const persisted = JSON.parse(await readFile(join(directory, 'phases', filename), 'utf8'));
    validatePhaseRecord(persisted, {
        runId: state.runId,
        artifact: state.artifact,
        scopeIdentity: state.scopeIdentity,
        assessmentIds: assigned.map((e) => e.assessmentId),
        inputRefs,
        phase,
        workUnitId,
        attempt,
    });
    await diagnostics.event('phase_completed', {
        phase,
        workUnitId,
        attempt,
        outputHash: record.outputHash,
        elapsedMs: Date.now() - Date.parse(startedAt),
    });
    // Reconciliation works on a copy; persisted handoffs remain immutable.
    return structuredClone(session.output!);
}
async function invokePhase<T>(
    run: ReviewRuntime,
    phase: 'assess' | 'verify',
    workUnitId: string,
    assigned: ReviewEntry[],
    payload: unknown,
    schema: z.ZodType,
    validate: (value: unknown) => T,
    attempt = 1,
): Promise<T> {
    const session = await createPhaseRuntime(run, phase, workUnitId, assigned, payload, schema, validate, attempt);
    await run.diagnostics.event('phase_started', { phase, workUnitId, attempt, inputHash: session.inputRefs[0]!.hash });
    let failure: unknown;
    try {
        await runPhaseModel(session);
    } catch (error) {
        failure = session.signal.aborted ? new BudgetStop(phaseStopReason(session, error)!) : error;
        await run.diagnostics.event('phase_failed', {
            elapsedMs: Date.now() - Date.parse(session.startedAt),
            phase,
            workUnitId,
            attempt,
            code:
                error instanceof BudgetStop
                    ? error.code
                    : session.signal.aborted
                      ? 'phase_deadline_or_cancelled'
                      : 'provider_or_execution_failed',
            details: { ...providerFailureDiagnostics(error), ...systemFailureDiagnostics(error) },
        });
    } finally {
        if (session.timer !== null) clearTimeout(session.timer);
    }
    try {
        return await persistPhaseResult(session, failure);
    } catch (error) {
        // persistPhaseResult rethrows the model failure after saving its handoff.
        // Only a different failure here means the handoff itself could not be persisted or validated.
        if (error !== failure) {
            await run.diagnostics
                .event(failure ? 'phase_persistence_failed' : 'phase_failed', {
                    phase,
                    workUnitId,
                    attempt,
                    code: 'phase_artifact_failed',
                    elapsedMs: Date.now() - Date.parse(session.startedAt),
                    details: { ...providerFailureDiagnostics(error), ...systemFailureDiagnostics(error) },
                })
                .catch(() => undefined);
        }
        throw failure ?? error;
    }
}
const requirementsFor = (run: ReviewRuntime) =>
    Object.fromEntries(
        Object.entries(run.material).map(([id, publication]) => [id, structuredRequirements(publication)]),
    );
const latestAssessment = (run: ReviewRuntime) =>
    run.state.phases.filter((phase) => phase.phase === 'assess' && phase.workUnitId === 'all').at(-1);
const nextAttempt = (run: ReviewRuntime, phase: ModelPhase) =>
    Math.max(
        0,
        ...run.state.phases
            .filter((record) => record.phase === phase && record.workUnitId === 'all')
            .map((record) => record.attempt),
    ) + 1;
function baseReviewPayload(run: ReviewRuntime) {
    return {
        reviewer: run.state.reviewer,
        artifact: run.state.artifact,
        purpose: run.options.purpose ?? null,
        prContext: run.prContext,
        diff: run.prepared.state.diff,
        changedFiles: run.prepared.state.changes,
        sourceLimits: run.source.limits,
    };
}
async function prepareRunEvidence(run: ReviewRuntime) {
    const { state, directory, prepared, prContext, material, ledger } = run;
    await atomicJson(join(directory, 'prepared.json'), sanitizeRecord(prepared.state));
    if (prContext) await atomicJson(join(directory, 'pr-context.json'), sanitizeRecord(prContext));
    for (const entry of state.entries) {
        if (!entry.material) continue;
        const pinned = publicationSchema.parse(material[entry.assessmentId]);
        if (
            pinned.nodeId !== entry.nodeId ||
            pinned.version !== entry.version ||
            pinned.subtype !== entry.subtype ||
            digest(pinned.content) !== entry.contentHash
        )
            throw new Error('pinned_material_changed');
    }
    for (const publication of Object.values(material)) ledger.publication(publication);
    run.evidencePack = prepareEvidencePack({ state: prepared.state, publications: material, ledger });
    await writeEvidencePack(directory, run.evidencePack);
    await run.persist();
}
async function restorePartialProposals(run: ReviewRuntime) {
    if (!run.options.resume) return;
    const last = latestAssessment(run);
    if (!last) return;
    const partial = JSON.parse(
        await readFile(join(run.directory, 'phases', `partial-assess-all-${last.attempt}.json`), 'utf8').catch(
            () => 'null',
        ),
    );
    if (!partial) return;
    const { state, ledger } = run;
    validatePhaseRecord(partial, {
        runId: state.runId,
        artifact: state.artifact,
        scopeIdentity: state.scopeIdentity,
        assessmentIds: state.entries.map((entry) => entry.assessmentId),
        inputRefs: last.inputRefs,
        phase: 'assess',
        workUnitId: 'all',
        attempt: last.attempt,
        requireComplete: false,
    });
    run.retainedProposals = (partial.output as { assessments: AssessmentProposal[] }).assessments.map((proposal) =>
        revalidateProposal(proposal, state.entries, ledger, requirementsFor(run)),
    );
}
async function assessRun(run: ReviewRuntime) {
    const previous = latestAssessment(run),
        { state, ledger } = run;
    if (previous?.status === 'complete') {
        const proposals = previous.output as AssessmentProposal[];
        exactIds(
            proposals.map((p) => p.result.assessmentId),
            state.entries.map((entry) => entry.assessmentId),
        );
        return proposals.map((proposal) => revalidateProposal(proposal, state.entries, ledger, requirementsFor(run)));
    }
    await restorePartialProposals(run);
    return invokePhase<AssessmentProposal[]>(
        run,
        'assess',
        'all',
        state.entries,
        {
            ...baseReviewPayload(run),
            expectedChecklist: state.entries.map(({ result: _result, ...entry }) => entry),
            evidencePack: run.evidencePack!.index,
            retained: run.retainedProposals,
            remaining: state.entries
                .filter((entry) => !run.retainedProposals.some((p) => p.result.assessmentId === entry.assessmentId))
                .map((entry) => entry.assessmentId),
        },
        reviewSelectionSchema,
        () => {
            throw new Error('assessment_accumulator_required');
        },
        nextAttempt(run, 'assess'),
    );
}
function applyEntryVerification(
    state: ReviewState,
    entry: ReviewEntry,
    proposal: AssessmentProposal,
    verification: VerificationEntry | undefined,
) {
    if (verification?.amendment) {
        state.checks.push(...verification.amendment.checks);
        state.findings.push(...verification.amendment.findings);
        entry.result = verification.amendment.result;
        state.verification.verified++;
        return;
    }
    const accepted = verification?.disposition === 'accept';
    const resolution = verification?.resolution;
    state.checks.push(...proposal.checks.map((check) => ({ ...check, verified: accepted })));
    state.findings.push(
        ...proposal.findings
            .filter(
                (finding) =>
                    !verification ||
                    verification.findings.some((item) => item.findingId === finding.findingId && item.accepted),
            )
            .map((finding) => {
                const decision = verification?.findings.find((item) => item.findingId === finding.findingId);
                return {
                    ...finding,
                    verified: decision?.accepted === true,
                    proposedReplacement: finding.proposedReplacement
                        ? {
                              ...finding.proposedReplacement,
                              verified: decision?.accepted === true && decision?.suggestionAccepted === true,
                          }
                        : undefined,
                };
            }),
    );
    if (accepted || resolution) {
        entry.result = resolution ?? proposal.result;
        state.verification.verified++;
        return;
    }
    entry.result = unresolvedVerificationResult(proposal, verification);
}
function unresolvedVerificationResult(
    proposal: AssessmentProposal,
    verification: VerificationEntry | undefined,
): AcceptedResult {
    return {
        ...proposal.result,
        disposition: 'unresolved',
        adherence: null,
        confidence: null,
        confidenceReason:
            'The original assessment was not accepted; the verifier did not provide a resolved replacement.',
        finding: 'none',
        consequence: 'This criterion remains incomplete; independently supported findings are reported separately.',
        correction: verification?.missingChecks.length
            ? verification.missingChecks.join(' ')
            : 'Resolve the verifier’s stated objection against the governing evidence.',
        citations: verification?.citations ?? [],
        explanation: verification?.reason ?? 'Independent verification did not complete.',
        limitations: verification?.missingChecks ?? ['Verification unavailable.'],
    };
}
async function verifyRun(run: ReviewRuntime, assessments: AssessmentProposal[]) {
    const { state, ledger } = run;
    const proposals = new Map(assessments.map((proposal) => [proposal.result.assessmentId, proposal]));
    const selected = state.entries.map((entry) => proposals.get(entry.assessmentId)!).filter(Boolean);
    const output = await invokePhase(
        run,
        'verify',
        'all',
        state.entries,
        { ...baseReviewPayload(run), evidencePack: run.evidencePack!.index, proposals: selected },
        verificationSelectionSchema,
        (value) => validateVerification(value, selected, ledger, state.entries, requirementsFor(run)),
        nextAttempt(run, 'verify'),
    );
    const verifications = new Map(output.map((verdict) => [verdict.assessmentId, verdict]));
    for (const entry of state.entries) {
        const proposal = proposals.get(entry.assessmentId);
        if (proposal) applyEntryVerification(state, entry, proposal, verifications.get(entry.assessmentId));
    }
    state.findings = reconcileFindings(state.findings);
    state.verification.complete = state.verification.verified === state.verification.expected;
    state.execution.scope =
        'Pinned governed assessment; read-only committed source and supplied evidence; independent phase verification recorded.';
}
async function executeReview(run: ReviewRuntime) {
    await prepareRunEvidence(run);
    const { state, models, options, prepared, preparedManifest, diagnostics } = run;
    if (state.preparationStatus !== 'prepared') {
        state.execution.stopReason = 'preparation_incomplete';
        return false;
    }
    for (const phase of ['assess', 'verify'] as const) reviewModel(models[phase], options.fetch ?? fetch);
    if (
        prepared.state.changes?.status !== 'complete' ||
        preparedManifest.changesHash !== digest(prepared.state.changes)
    ) {
        await diagnostics.event('preparation_inventory_rejected', { code: 'upstream_artifact_changed' });
        throw new Error('upstream_artifact_changed');
    }
    await verifyRun(run, await assessRun(run));
    const newPhases = state.phases.slice(run.invocationPhaseIndex);
    state.execution.stopReason = newPhases.find((phase) => phase.status !== 'complete')?.stopReason ?? 'finished';
    return newPhases.some((phase) => phase.status !== 'complete');
}
export async function runReview(options: ReviewOptions) {
    const run = await createReviewRuntime(options);
    let executionFailure = false;
    try {
        executionFailure = await executeReview(run);
    } catch (error) {
        executionFailure = true;
        run.state.execution.stopReason =
            error instanceof BudgetStop
                ? error.code
                : options.signal?.aborted
                  ? 'cancelled'
                  : knownExecutionFailure(error);
        await run.diagnostics
            .event('execution_stopped', {
                code: run.state.execution.stopReason,
                details: { ...providerFailureDiagnostics(error), ...systemFailureDiagnostics(error) },
            })
            .catch(() => undefined);
    }
    return finalizeReview(run, executionFailure);
}
async function deliverReviewFeedback(state: ReviewState, options: ReviewOptions): Promise<ReportingStatus> {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            sendReviewReport(state, {
                mode: options.feedback,
                sender: options.feedbackSender,
                repositoryAttribution: options.repositoryAttribution,
            }),
            new Promise<ReportingStatus>((resolve) => {
                cleanupTimer = setTimeout(() => resolve({ status: 'failed', code: 'submission_failed' }), 10_000);
            }),
        ]);
    } finally {
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    }
}
async function sealReportArtifacts(directory: string, state: ReviewState) {
    const hashes: Record<string, string> = {};
    for (const name of await readdir(directory)) {
        if (name === 'manifest.json' || name.endsWith('.tmp')) continue;
        if (name === 'phases') {
            for (const child of await readdir(join(directory, name)))
                hashes[`${name}/${child}`] = `sha256:${createHash('sha256')
                    .update(await readFile(join(directory, name, child)))
                    .digest('hex')}`;
        } else
            hashes[name] = `sha256:${createHash('sha256')
                .update(await readFile(join(directory, name)))
                .digest('hex')}`;
    }
    let original: Record<string, unknown> = {};
    try {
        original = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    } catch {
        original = {};
    }
    await atomicJson(join(directory, 'manifest.json'), {
        ...original,
        runId: state.runId,
        files: hashes,
        capture: state.execution.capture,
    });
}
async function finalizeReview(run: ReviewRuntime, executionFailure: boolean) {
    const { state, directory, budget, diagnostics, persist, options, prepared, previousElapsed } = run;
    state.execution.elapsedMs = previousElapsed + Date.now() - budget.started;
    state.decision = decideExit(
        state.entries,
        state.execution.policy,
        !state.verification.complete || state.preparationStatus !== 'prepared',
        executionFailure,
        state.findings,
    );
    state.reviewStatus = state.decision.complete && !executionFailure ? 'complete' : 'incomplete';
    const reportPath = join(directory, 'report.json');
    const started = performance.now();
    const primaryStopReason = state.execution.stopReason;
    let stage = 'diagnostics';
    try {
        await diagnostics.event('review_finalization_started', {
            status: state.reviewStatus,
            exitCode: state.decision.exitCode,
            elapsedMs: state.execution.elapsedMs,
            complete: state.verification.complete,
        });
        stage = 'state_write';
        await persist();
        stage = 'json_report';
        await atomicJson(reportPath, sanitizeRecord(state));
        stage = 'markdown_report';
        await writeFile(join(directory, 'report.md'), markdownReport(state), { mode: 0o600 });
        stage = 'feedback';
        state.execution.reporting = await deliverReviewFeedback(state, options);
        await diagnostics.event('review_reporting', { reporting: state.execution.reporting.status });
        stage = 'reporting_status';
        await atomicJson(join(directory, 'reporting-status.json'), {
            runId: state.runId,
            reporting: state.execution.reporting,
        });
        stage = 'state_write';
        await persist();
        stage = 'json_report';
        await atomicJson(reportPath, sanitizeRecord(state));
        stage = 'markdown_report';
        await writeFile(join(directory, 'report.md'), markdownReport(state), { mode: 0o600 });
        stage = 'diagnostics';
        await diagnostics.event('review_finalized', {
            status: state.reviewStatus,
            exitCode: state.decision.exitCode,
            elapsedMs: state.execution.elapsedMs,
            complete: state.verification.complete,
        });
        await diagnostics.flush();
        stage = 'artifact_seal';
        await sealReportArtifacts(directory, state);
    } catch (error) {
        state.decision = { ...state.decision, exitCode: 2 };
        state.reviewStatus = 'incomplete';
        state.execution.stopReason = executionFailure ? primaryStopReason : 'report_delivery_failed';
        await diagnostics
            .event('finalization_failed', {
                code: 'report_delivery_failed',
                primaryStopReason,
                stage,
                elapsedMs: performance.now() - started,
                details: { ...providerFailureDiagnostics(error), ...systemFailureDiagnostics(error) },
            })
            .catch(() => undefined);
        if (state.execution.reporting.status === 'pending')
            state.execution.reporting =
                options.feedback === 'off' ? { status: 'off' } : { status: 'failed', code: 'finalization_unavailable' };
        await atomicJson(prepared.statePath, sanitizeRecord(state)).catch(() => undefined);
        await atomicJson(reportPath, sanitizeRecord(state)).catch(() => undefined);
    }
    return { state: sanitizeRecord(state), statePath: prepared.statePath, reportPath, directory };
}
function markdownReport(state: ReviewState) {
    const coverage = assessmentCoverage(state);
    const progressLabel = (assessmentId: string) => {
        const progress = coverage.entries.find((p) => p.assessmentId === assessmentId);
        return progress?.status === 'awaiting_verification'
            ? 'Assessed; awaiting independent verification.'
            : progress?.status === 'needs_reassessment'
              ? 'Previously assessed; needs reassessment before independent acceptance.'
              : progress?.status === 'verified_unresolved'
                ? 'Independently checked; assessment remains unresolved and needs evidence.'
                : progress?.status === 'verified'
                  ? 'Independently verified.'
                  : 'Unexamined: no complete canonical assessment handoff is recorded.';
    };
    return (
        `# Governed review ${state.runId}\n\nAssessment: **${state.reviewStatus}**; review exit ${state.decision?.reviewExit}; process exit ${state.decision?.exitCode}.\n\n${state.artifact.base.commit} → ${state.artifact.head.commit}\n\n[Open prepared Git diff](diff.patch) · [Preparation summary](preparation.md)\n\nAssessed ${coverage.assessed}/${coverage.total} governed context assessments; ${coverage.awaitingVerification} awaiting independent verification; ${coverage.needsReassessment} need reassessment; ${coverage.unexamined} unexamined. Verified ${state.verification.verified}/${state.verification.expected}. Assessment proposals are not accepted findings until independently verified. No runtime tests were executed.\n\n` +
        state.entries
            .map((e) => {
                const r = e.result;
                return (
                    `## ${e.nodeId} @${e.version}\n\n${progressLabel(e.assessmentId)}\n\nFinal canonical outcome: ${r.disposition}; adherence ${r.adherence ?? 'unknown'}; confidence ${r.confidence ?? 'unknown'}\n\n` +
                    ('explanation' in r
                        ? `${r.explanation}\n\nCorrection: ${r.correction}\n\nLimits: ${r.limitations.join('; ')}\n\n${r.citations.map((c) => `${c.ref}: ${JSON.stringify(c.quote)}`).join('\n\n')}`
                        : progressLabel(e.assessmentId))
                );
            })
            .join('\n\n') +
        `\n\n## Run details\n\nPhase models: ${JSON.stringify(state.execution.phaseModels)}\n\nDuration ${state.execution.elapsedMs}ms; ${state.execution.calls} calls; stop ${state.execution.stopReason}.\n\n${state.execution.capture}\n`
    );
}
