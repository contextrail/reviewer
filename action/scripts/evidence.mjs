import { cpSync, existsSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { config, currentPR, e, eligible, guarded, output, read, write } from './common.mjs';

function copyPublicationFile(from, to) {
    if (!existsSync(from)) return false;
    const stat = lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return false;
    cpSync(from, to);
    return true;
}
function copyPublicationRecords(from, to) {
    let files = 0;
    for (const name of ['publication.json', 'publication-payloads.json']) {
        if (copyPublicationFile(join(from, name), join(to, name))) files++;
    }
    return files;
}
function capturePublicationEvidence(root) {
    const directory = join(root, 'publication-evidence');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of ['comment-status.json', 'summary-status.json', 'comparison.json'])
        copyPublicationFile(join(root, name), join(directory, name));
    const runs = join(root, 'comparison/.contextrail/reviewer');
    let files = 0;
    const directories = existsSync(runs) ? readdirSync(runs, { withFileTypes: true }) : [];
    for (const run of directories) {
        if (!run.isDirectory() || !/^[A-Za-z0-9_-]{1,200}$/.test(run.name)) continue;
        const target = join(directory, run.name);
        mkdirSync(target, { recursive: true, mode: 0o700 });
        files += copyPublicationRecords(join(runs, run.name), target);
    }
    // Startup failures can publish a bounded unavailable-assessment comment from the root.
    files += copyPublicationRecords(root, directory);
    write(join(directory, 'capture-status.json'), {
        stage: 'publication',
        status: files ? 'captured' : 'no_confirmed_publication_records',
        files,
        limitations: files
            ? []
            : ['Posting may have been disabled, skipped or failed before acknowledgement; absence is not success.'],
    });
    output('path', directory);
    output('available', 'true');
}
async function comparisonFreshness(fixed) {
    try {
        const c = config(),
            pr = await currentPR(c);
        return eligible(pr, c) && pr.base.sha === fixed.base && pr.head.sha === fixed.head
            ? 'current_at_finish'
            : 'superseded';
    } catch {
        // A failed read is uncertainty, never evidence that a comparison is current.
        return 'unknown';
    }
}
function captureReviewEvidence(root) {
    const evidence = join(root, 'evidence');
    mkdirSync(evidence, { recursive: true });
    for (const name of [
        'config.json',
        'context-status.json',
        'setup-status.json',
        'comparison-status.json',
        'comparison.json',
        'review-status.json',
        'package-lock.json',
        'cli-stdout.log',
        'cli-stderr.log',
    ]) {
        if (existsSync(join(root, name))) cpSync(join(root, name), join(evidence, name));
    }
    const runs = join(root, 'comparison/.contextrail/reviewer');
    if (existsSync(runs)) cpSync(runs, join(evidence, 'reviewer'), { recursive: true });
    output('path', evidence);
    output('available', readdirSync(evidence).length > 0 ? 'true' : 'false');
}
await guarded('evidence', async () => {
    if (!e.REVIEW_ROOT || !existsSync(e.REVIEW_ROOT)) return;
    if (e.PUBLICATION_ONLY === 'true') return capturePublicationEvidence(e.REVIEW_ROOT);
    const fixed = read(join(e.REVIEW_ROOT, 'comparison.json'));
    if (fixed) {
        const freshness = await comparisonFreshness(fixed);
        write(join(e.REVIEW_ROOT, 'comparison.json'), { ...fixed, freshness });
        output('comparison-status', freshness);
    }
    captureReviewEvidence(e.REVIEW_ROOT);
});
