import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, currentPR, e, eligible, guarded, output, read, write } from './common.mjs';

await guarded('evidence', async () => {
    if (!e.REVIEW_ROOT || !existsSync(e.REVIEW_ROOT)) return;
    const fixed = read(join(e.REVIEW_ROOT, 'comparison.json'));
    if (fixed) {
        let freshness = 'unknown';
        try {
            const c = config(),
                pr = await currentPR(c);
            freshness =
                eligible(pr, c) && pr.base.sha === fixed.base && pr.head.sha === fixed.head
                    ? 'current_at_finish'
                    : 'superseded';
        } catch {
            /* A failed read is uncertainty, never evidence that a comparison is current. */
        }
        write(join(e.REVIEW_ROOT, 'comparison.json'), { ...fixed, freshness });
        output('comparison-status', freshness);
    }
    const evidence = join(e.REVIEW_ROOT, 'evidence');
    mkdirSync(evidence, { recursive: true });
    for (const name of [
        'config.json',
        'setup-status.json',
        'comparison-status.json',
        'comparison.json',
        'review-status.json',
        'package-lock.json',
        'cli-stdout.log',
        'cli-stderr.log',
    ]) {
        if (existsSync(join(e.REVIEW_ROOT, name))) cpSync(join(e.REVIEW_ROOT, name), join(evidence, name));
    }
    const runs = join(e.REVIEW_ROOT, 'comparison/.contextrail/reviewer');
    if (existsSync(runs)) cpSync(runs, join(evidence, 'reviewer'), { recursive: true });
    output('path', evidence);
    output('available', readdirSync(evidence).length > 0 ? 'true' : 'false');
});
