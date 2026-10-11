import { packageVersion } from './version.js';
import { reviewReportInputSchema, type ReviewReportInput, type ReviewReportReceipt } from './report-contract.js';
import { reportedUsage } from './providers.js';
import type { ReviewState } from './review.js';

export type ReportingStatus =
    | { status: 'pending' | 'off' }
    | { status: 'received'; receipt: ReviewReportReceipt }
    | {
          status: 'failed';
          code:
              | 'projection_invalid'
              | 'sender_unavailable'
              | 'submission_failed'
              | 'receipt_invalid'
              | 'local_status_write_failed'
              | 'finalization_unavailable';
      };
export interface ReviewFeedbackSender {
    submitReport(report: ReviewReportInput): Promise<unknown>;
}

/** Construct from the allowlist. Never serialize local state then remove fields. */
export function projectReviewReport(state: ReviewState, repositoryAttribution = false): ReviewReportInput {
    if (!state.reviewer || !state.decision || state.reviewStatus === 'running') throw new Error('review_not_finalized');
    const e = state.execution;
    const stop: Record<string, ReviewReportInput['stopReason']> = {
        finished: 'finished',
        preparation_incomplete: 'preparation_incomplete',
        cancelled: 'cancelled',
        max_time_ms: 'timeout',
        max_turns: 'max_turns',
        max_total_tokens: 'max_total_tokens',
        usage_unavailable: 'usage_unavailable',
        provider_error: 'provider_error',
        execution_error: 'execution_error',
        report_delivery_failed: 'report_delivery_failed',
        per_call_output_limit: 'output_limit',
        model_stopped: 'model_stopped',
        total_token_limit_unmeasurable: 'usage_unavailable',
    };
    const repository = state.artifact.repositoryEnvironment;
    return reviewReportInputSchema.parse({
        kind: 'review_report',
        contractVersion: 1,
        runId: state.runId,
        origin: 'npm',
        packageVersion,
        methodVersion: 'context-review-v1',
        reviewer: { nodeId: state.reviewer.nodeId, version: state.reviewer.version },
        repository: repositoryAttribution
            ? repository.status === 'reported'
                ? { status: 'reported', provider: repository.provider, owner: repository.owner, name: repository.name }
                : { status: 'unavailable', reason: repository.reason }
            : { status: 'unavailable', reason: 'withheld' },
        scope: {
            enumeration: state.preparationStatus === 'prepared' ? 'complete' : 'incomplete',
            expectedCount: state.expectedContextCount,
            expected: state.entries.map((entry) => ({
                entryId: entry.assessmentId,
                context: { nodeId: entry.nodeId, version: entry.version },
            })),
        },
        outcomes: state.entries.map((entry) => ({
            entryId: entry.assessmentId,
            disposition: entry.result.disposition,
            adherence: entry.result.adherence,
            confidence: entry.result.confidence,
            finding: 'finding' in entry.result ? entry.result.finding : 'none',
            blocking: state.decision!.reasons.some(
                (reason) => reason.assessmentId === entry.assessmentId && reason.blocking,
            ),
        })),
        runner: {
            policy: {
                minAdherence: e.policy.minAdherence,
                minConfidence: e.policy.minConfidence,
                advisory: e.policy.advisory,
            },
            reviewExit: state.decision.reviewExit,
            exitCode: state.decision.exitCode,
        },
        completion: state.reviewStatus,
        stopReason: stop[e.stopReason ?? ''] ?? 'execution_error',
        telemetry: {
            durationMs: e.elapsedMs,
            provider: e.requested.provider,
            model: e.requested.model,
            harness: 'v2-review-agent',
            returned: e.returnedIdentities.map((id) => ({ provider: id.provider, model: id.model })),
            calls: e.calls,
            usage: Array.from({ length: e.calls }, (_, i) => {
                const u = reportedUsage(e.requested.provider, e.providerUsage.find((u) => u.call === i + 1)?.usage);
                return {
                    call: i + 1,
                    inputTokens: u.inputTokens,
                    outputTokens: u.outputTokens,
                    totalTokens: u.totalTokens,
                    cachedInputTokens: u.cachedInputTokens,
                    reasoningTokens: u.reasoningTokens,
                };
            }),
        },
    });
}
export async function sendReviewReport(
    state: ReviewState,
    options: { mode?: 'send' | 'off'; repositoryAttribution?: boolean; sender?: ReviewFeedbackSender },
): Promise<ReportingStatus> {
    if (options.mode === 'off') return { status: 'off' };
    let report: ReviewReportInput;
    try {
        report = projectReviewReport(state, options.repositoryAttribution);
    } catch {
        return { status: 'failed', code: 'projection_invalid' };
    }
    if (!options.sender) return { status: 'failed', code: 'sender_unavailable' };
    try {
        const raw = await options.sender.submitReport(report);
        if (!raw || typeof raw !== 'object') return { status: 'failed', code: 'receipt_invalid' };
        const receipt = raw as ReviewReportReceipt;
        // A hostile response must never become an arbitrary local reporting metadata bag.
        if (
            receipt.runId !== state.runId ||
            typeof receipt.duplicate !== 'boolean' ||
            typeof receipt.eventId !== 'string' ||
            !/^effectiveness:\/\/[A-Za-z0-9_/-]+$/u.test(receipt.eventId) ||
            receipt.eventId.length > 500 ||
            typeof receipt.receivedAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(receipt.receivedAt) ||
            !Number.isFinite(Date.parse(receipt.receivedAt))
        )
            return { status: 'failed', code: 'receipt_invalid' };
        return {
            status: 'received',
            receipt: {
                runId: receipt.runId,
                eventId: receipt.eventId,
                receivedAt: receipt.receivedAt,
                duplicate: receipt.duplicate,
            },
        };
    } catch {
        // No provider bodies, upstream error strings or unknown keys reach diagnostics.
        return { status: 'failed', code: 'submission_failed' };
    }
}
