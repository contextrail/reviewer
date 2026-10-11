import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { e, guarded, output, read } from './common.mjs';

await guarded('summary', () => {
    const root = e.REVIEW_ROOT;
    const at = (name) => (root ? read(join(root, name)) : null);
    const c = at('config.json'),
        fixed = at('comparison.json'),
        review = at('review-status.json');
    let state = null,
        reporting = null;
    try {
        const runs = join(root, 'comparison/.contextrail/reviewer');
        const dirs = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory());
        if (dirs.length === 1) {
            const directory = join(runs, dirs[0].name);
            const candidate = read(join(directory, 'state.json')) ?? read(join(directory, 'report.json'));
            // Do not attribute unrelated or malformed evidence to this comparison/reviewer.
            if (
                candidate?.artifact?.base?.commit === fixed?.base &&
                candidate?.artifact?.head?.commit === fixed?.head &&
                (!candidate?.reviewer || candidate.reviewer.nodeId === c?.reviewer) &&
                candidate?.runId === dirs[0].name &&
                /^[A-Za-z0-9_-]{1,200}$/.test(candidate?.runId ?? '')
            ) {
                state = candidate;
                reporting = read(join(directory, 'reporting-status.json'))?.reporting ?? state.execution?.reporting;
            }
        }
    } catch {
        /* Startup/setup failure can have no run directory. */
    }
    const oneOf = (value, choices, fallback = 'unknown') => (choices.includes(value) ? value : fallback);
    const exit = oneOf(review?.exit, [0, 1, 2], 'not run / interrupted');
    const status = oneOf(reporting?.status, ['received', 'failed', 'pending', 'off'], 'unavailable');
    const completion = oneOf(state?.reviewStatus, ['complete', 'incomplete', 'running', 'not_started']);
    const version =
        Number.isSafeInteger(state?.reviewer?.version) && state.reviewer.version > 0
            ? state.reviewer.version
            : 'unconfirmed';
    const entries = Array.isArray(state?.entries) ? state.entries : null;
    const count = (finding) => (entries ? entries.filter((v) => v?.result?.finding === finding).length : 'unavailable');
    const artifact =
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+\/artifacts\/[0-9]+$/.test(
            e.ARTIFACT_URL ?? '',
        )
            ? e.ARTIFACT_URL
            : null;
    const freshness = oneOf(fixed?.freshness, ['current_at_finish', 'current_before_review', 'superseded']);
    const failedStage = ['setup', 'comparison', 'review', 'evidence'].find(
        (s) => at(`${s}-status.json`)?.status === 'failed',
    );
    if (state) output('run-id', state.runId);
    output('feedback-status', status);
    appendFileSync(
        e.GITHUB_STEP_SUMMARY,
        [
            '### ContextRail review',
            fixed
                ? `PR #${fixed.pr}: \`${fixed.base}\` → \`${fixed.head}\`.`
                : 'Comparison: unavailable; no review result confirmed.',
            `Package: @contextrail/code-review-agent @ ${c?.packageVersion ?? 'unconfigured'}. Reviewer: ${c?.reviewer ?? 'unconfigured'} @ ${version}.`,
            `Review exit: ${exit}; completion: ${completion}; run ID: ${state?.runId ?? 'unavailable'}.`,
            `Scope entries: ${entries?.length ?? 'unavailable'}; binding violations: ${count('binding_violation')}; behavioral defects: ${count('behavioral_defect')}; guidance departures: ${count('guidance_departure')}.`,
            `ContextRail feedback: ${status}${status === 'received' ? ' (ingestion receipt only)' : '; no receipt confirmed'}.`,
            `Comparison: ${freshness === 'superseded' ? 'SUPERSEDED or closed; historical result only' : freshness === 'current_at_finish' ? 'matched current eligible PR at finish; verify SHAs before use' : 'currency unknown; verify current PR before use'}.`,
            failedStage ? `Action ${failedStage} failed; no successful setup/review is implied.` : '',
            `Evidence upload: ${oneOf(e.ARTIFACT_OUTCOME, ['success', 'failure', 'skipped', 'cancelled'])}. ${artifact ? `[Artifact bundle](${artifact})` : 'No artifact URL available.'}`,
            'Full reports/audit may contain source and model conversations. Review policy acceptance is bounded; it does not certify compliance.',
            '',
        ]
            .filter((line) => line !== '')
            .join('\n\n') + '\n',
    );
});
