import { config, e, guarded, loadReviewerModule, output } from './common.mjs';
await guarded('comparison', async () => {
    const c = config();
    const { prepareGitHubReview } = await loadReviewerModule('github');
    const prepared = await prepareGitHubReview({
        repository: c.repository,
        prNumber: c.pr,
        reviewer: c.reviewer,
        outputDir: e.REVIEW_ROOT,
        baseBranch: c.baseBranch,
        fixed: c.fixed,
        token: e.GH_READ_TOKEN,
    });
    output('pr-context-path', prepared.prContextPath);
});
