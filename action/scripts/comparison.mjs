import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { config, currentPR, e, eligible, fail, gitEnvironment, guarded, write } from './common.mjs';

await guarded('comparison', async () => {
    const c = config(),
        pr = await currentPR(c);
    if (!eligible(pr, c)) fail('ineligible_pr');
    const fixed = c.fixed ?? { base: pr.base.sha, head: pr.head.sha };
    if (pr.base.sha !== fixed.base || pr.head.sha !== fixed.head) fail('superseded_comparison');
    const repository = join(e.REVIEW_ROOT, 'comparison');
    const git = (args, authenticated = false) => {
        const env = gitEnvironment();
        if (authenticated)
            Object.assign(env, {
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${e.GH_READ_TOKEN}`).toString('base64')}`,
            });
        const result = spawnSync(
            'git',
            [
                '-c',
                'core.hooksPath=/dev/null',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'credential.helper=',
                '-c',
                'protocol.file.allow=never',
                ...args,
            ],
            { env, stdio: 'pipe', timeout: 120000, encoding: 'utf8' },
        );
        if (result.status !== 0) fail('git_fetch_failed');
        return result.stdout.trim();
    };
    git(['init', '--template=', repository]);
    git(['-C', repository, 'remote', 'add', 'origin', `https://github.com/${c.repository}.git`]);
    git(['-C', repository, 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', fixed.base, fixed.head], true);
    for (const commit of Object.values(fixed)) {
        if (git(['-C', repository, 'rev-parse', '--verify', `${commit}^{commit}`]) !== commit)
            fail('fixed_commit_invalid');
    }
    // Recheck after fetch, before provider credentials are introduced.
    const latest = await currentPR(c);
    if (!eligible(latest, c) || latest.base.sha !== fixed.base || latest.head.sha !== fixed.head)
        fail('superseded_comparison');
    write(join(e.REVIEW_ROOT, 'comparison.json'), {
        ...fixed,
        repository: c.repository,
        pr: c.pr,
        workflowSha: e.GITHUB_WORKFLOW_SHA,
        freshness: 'current_before_review',
    });
});
