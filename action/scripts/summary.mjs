import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { e, guarded, loadReviewerModule, output, read, write } from './common.mjs';

function matchesComparison(candidate, name, config, fixed) {
    if (!candidate || !fixed || !config) return false;
    const artifact = candidate.artifact ?? {},
        base = artifact.base ?? {},
        head = artifact.head ?? {};
    return (
        base.commit === fixed.base &&
        head.commit === fixed.head &&
        candidate.reviewer?.nodeId === config.reviewer &&
        candidate.runId === name
    );
}
function reviewState(root, config, fixed) {
    try {
        const runs = join(root, 'comparison/.contextrail/reviewer');
        const dirs = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory());
        if (dirs.length !== 1) return { directory: null, state: null };
        const directory = join(runs, dirs[0].name);
        const candidate = read(join(directory, 'state.json')) ?? read(join(directory, 'report.json'));
        return { directory, state: matchesComparison(candidate, dirs[0].name, config, fixed) ? candidate : null };
    } catch {
        // Setup failures can have no confirmed review state.
        return { directory: null, state: null };
    }
}
function readStopDiagnostic(directory, name) {
    try {
        const stopped = readFileSync(join(directory, name), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .findLast((event) => event.kind === 'execution_stopped');
        return stopped ? stopDiagnostic(stopped) : null;
    } catch {
        // Missing or malformed diagnostics do not establish success.
        return null;
    }
}
function stopDiagnostic(stopped) {
    const data = stopped.data ?? {};
    const header = `Failure: ${data.category ?? 'unknown'}; HTTP ${data.status ?? 'unknown'}; call ${data.call ?? 'unknown'}.`;
    const issues = (data.details?.validation ?? [])
        .slice(0, 3)
        .map(
            (issue) =>
                ` Validation ${issue.code} at ${Array.isArray(issue.path) ? issue.path.join('.') : 'unknown'}: expected ${issue.expected}, actual ${issue.actual}.`,
        );
    return header + issues.join('');
}
function diagnosticForRun(directory, state) {
    if (!directory || state?.execution?.stopReason === 'finished') return '';
    for (const name of ['diagnostics.jsonl', 'audit.jsonl']) {
        const diagnostic = readStopDiagnostic(directory, name);
        if (diagnostic) return diagnostic;
    }
    return '';
}
function summaryOptions(root, config, fixed, review, directory, state) {
    const comparisonLabels = new Map([
        ['current_at_finish', 'Matched current PR at finish; verify SHAs before use'],
        ['superseded', 'SUPERSEDED; historical result only'],
    ]);
    return {
        packageVersion: config?.packageVersion,
        reviewExit: review?.exit,
        artifactOutcome: e.ARTIFACT_OUTCOME,
        feedback: config?.feedback,
        artifactUrl: e.ARTIFACT_URL,
        runUrl:
            config?.repository && /^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? '')
                ? `https://github.com/${config.repository}/actions/runs/${e.GITHUB_RUN_ID}`
                : undefined,
        failedStage: ['setup', 'comparison', 'context', 'review', 'evidence'].find(
            (stage) => read(join(root, `${stage}-status.json`))?.status === 'failed',
        ),
        diagnostic: diagnosticForRun(directory, state),
        comparisonStatus: comparisonLabels.get(fixed?.freshness) ?? 'Currency unknown; verify SHAs before use',
    };
}
function writeHistoryRun(root, config, fixed, state, review, presentation) {
    if (!config || !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? '')) return;
    const usage = presentation.summarizeUsage(state);
    write(
        join(root, 'comment-run.json'),
        presentation.runRecord(
            { ...config, githubRun: e.GITHUB_RUN_ID, githubAttempt: Number(e.GITHUB_RUN_ATTEMPT) },
            fixed,
            state,
            review?.exit,
            usage.cost.value,
            usage.cost.complete,
        ),
    );
}
await guarded('summary', async () => {
    const presentation = await loadReviewerModule('presentation');
    const root = e.REVIEW_ROOT,
        config = read(join(root, 'config.json')),
        fixed = read(join(root, 'comparison.json')),
        review = read(join(root, 'review-status.json'));
    const { directory, state } = reviewState(root, config, fixed);
    const options = summaryOptions(root, config, fixed, review, directory, state);
    appendFileSync(e.GITHUB_STEP_SUMMARY, presentation.renderActionSummary(state, options));
    writeFileSync(join(root, 'summary.md'), presentation.renderReviewComment(state, options), { mode: 0o600 });
    if (state) output('run-id', state.runId);
    output('feedback-status', state?.execution?.reporting?.status ?? 'unavailable');
    writeHistoryRun(root, config, fixed, state, review, presentation);
});
