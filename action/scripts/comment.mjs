import { findReviewComment, withHistory } from './history.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, currentPR, githubRequest, e, eligible, fail, guarded, output, read } from './common.mjs';

await guarded('comment', async () => {
    const finish = (status, url = '') => {
        output('comment-status', status);
        appendFileSync(e.GITHUB_STEP_SUMMARY, `\nPR comment: ${status}.${url ? ` [View comment](${url})` : ''}\n`);
    };
    try {
        const c = config();
        if (
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repository ?? '') ||
            !Number.isSafeInteger(c.pr) ||
            c.pr < 1 ||
            typeof c.reviewer !== 'string' ||
            !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? '') ||
            !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ATTEMPT ?? '') ||
            !e.GH_READ_TOKEN
        )
            fail('invalid_configuration');
        const summary = readFileSync(join(e.REVIEW_ROOT, 'summary.md'), 'utf8');
        if (!summary || summary.length > 50000) fail('comment_summary_invalid');
        const previous = await findReviewComment(c);
        const old = previous?.body.match(/\n<!-- contextrail-run:([1-9][0-9]*):([1-9][0-9]*) -->\n/);
        if (
            old &&
            (BigInt(old[1]) > BigInt(e.GITHUB_RUN_ID) ||
                (old[1] === e.GITHUB_RUN_ID && BigInt(old[2]) > BigInt(e.GITHUB_RUN_ATTEMPT)))
        )
            return finish('skipped_newer');
        // Recheck after listing: a report for a moved PR must not replace its current comment.
        const pr = await currentPR(c),
            fixed = read(join(e.REVIEW_ROOT, 'comparison.json'));
        if (!eligible(pr, c)) fail('ineligible_pr');
        if (fixed && (fixed.base !== pr.base.sha || fixed.head !== pr.head.sha)) return finish('skipped_superseded');
        const current = read(join(e.REVIEW_ROOT, 'comment-run.json'));
        if (!current || current.row.id !== e.GITHUB_RUN_ID || current.row.attempt !== Number(e.GITHUB_RUN_ATTEMPT))
            fail('history_invalid');
        const body = withHistory(summary, previous, current, c);
        const result = previous
            ? await githubRequest(c, `/issues/comments/${previous.id}`, 'PATCH', { body })
            : await githubRequest(c, `/issues/${c.pr}/comments`, 'POST', { body });
        if (!Number.isSafeInteger(result?.id) || result.id < 1) fail('comment_acknowledgement_invalid');
        finish(
            previous ? 'updated' : 'created',
            `https://github.com/${c.repository}/pull/${c.pr}#issuecomment-${result.id}`,
        );
    } catch {
        finish('failed');
        // No upstream error body/message or token is copied to logs; no automatic write retry.
        fail('comment_failed');
    }
});
