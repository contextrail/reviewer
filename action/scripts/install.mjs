import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { e, fail, guarded, output, read, runtimeEnvironment, write } from './common.mjs';

await guarded('setup', () => {
    e.REVIEW_ROOT = mkdtempSync(join(e.RUNNER_TEMP, 'contextrail-review-'));
    output('root', e.REVIEW_ROOT);
    const positive = (v, max) => /^[1-9][0-9]*$/.test(v ?? '') && Number.isSafeInteger(Number(v)) && Number(v) <= max;
    const bounded = (v, pattern, max = 500) => typeof v === 'string' && v.length <= max && pattern.test(v);
    // Exact SemVer only: no dist-tags, ranges, URLs, aliases, leading v or local paths.
    const number = '(?:0|[1-9][0-9]*)';
    const prerelease = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
    const version = new RegExp(
        `^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
    );
    if (!e.PACKAGE_VERSION) fail('package_version_missing');
    if (!bounded(e.PACKAGE_VERSION, version, 100)) fail('invalid_package_version');
    const url = (() => {
        try {
            return new globalThis.URL(e.MCP_URL);
        } catch {
            return null;
        }
    })();
    if (
        !bounded(e.REVIEWER, /^skill:\/\/[A-Za-z0-9._/-]+$/) ||
        !url ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !bounded(e.MCP_ORG_ID, /^[A-Za-z0-9._-]+$/, 200) ||
        !['openai', 'openrouter'].includes(e.PROVIDER) ||
        !bounded(e.MODEL, /^[A-Za-z0-9._:/-]+$/, 200) ||
        !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(e.EFFORT) ||
        !positive(e.MAX_TIME_MS, 2147483647) ||
        !['send', 'off'].includes(e.FEEDBACK) ||
        !['true', 'false'].includes(e.REPOSITORY_ATTRIBUTION) ||
        !positive(e.ARTIFACT_RETENTION_DAYS, 90) ||
        !positive(e.PR_NUMBER, Number.MAX_SAFE_INTEGER) ||
        !bounded(e.GITHUB_REPOSITORY, /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/, 301) ||
        !bounded(e.BASE_BRANCH, /^(?!-)[A-Za-z0-9._/-]+$/, 200) ||
        e.GITHUB_SERVER_URL !== 'https://github.com'
    )
        fail('invalid_configuration');
    output('retention', e.ARTIFACT_RETENTION_DAYS);
    const event = read(e.GITHUB_EVENT_PATH);
    let fixed = null;
    if (e.GITHUB_EVENT_NAME === 'pull_request_target' && event?.action === 'labeled') {
        if (String(event.pull_request?.number) !== e.PR_NUMBER) fail('event_rejected');
        fixed = { base: event.pull_request?.base?.sha, head: event.pull_request?.head?.sha };
        if (!Object.values(fixed).every((v) => /^[a-f0-9]{40}$/.test(v ?? ''))) fail('event_comparison_invalid');
    } else if (e.GITHUB_EVENT_NAME !== 'workflow_dispatch') fail('event_rejected');
    const c = {
        packageVersion: e.PACKAGE_VERSION,
        reviewer: e.REVIEWER,
        mcpUrl: e.MCP_URL,
        org: e.MCP_ORG_ID,
        provider: e.PROVIDER,
        model: e.MODEL,
        effort: e.EFFORT,
        maxTimeMs: e.MAX_TIME_MS,
        feedback: e.FEEDBACK,
        repositoryAttribution: e.REPOSITORY_ATTRIBUTION === 'true',
        repository: e.GITHUB_REPOSITORY,
        pr: Number(e.PR_NUMBER),
        baseBranch: e.BASE_BRANCH,
        fixed,
    };
    write(join(e.REVIEW_ROOT, 'config.json'), c);
    const tool = join(e.REVIEW_ROOT, 'tool');
    mkdirSync(tool);
    // Empty cwd + explicit configs/registry + clean environment: no consumer .npmrc or source fallback.
    const userConfig = join(tool, 'user.npmrc'),
        globalConfig = join(tool, 'global.npmrc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    const result = spawnSync(
        'npm',
        [
            'install',
            '--prefix',
            tool,
            '--userconfig',
            userConfig,
            '--globalconfig',
            globalConfig,
            '--registry',
            'https://registry.npmjs.org',
            '--cache',
            join(tool, 'cache'),
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--save-exact',
            `@contextrail/code-review-agent@${c.packageVersion}`,
        ],
        {
            cwd: tool,
            env: runtimeEnvironment(),
            stdio: 'pipe',
            timeout: 180000,
        },
    );
    if (result.status !== 0) fail('package_install_failed');
    const pkg = read(join(tool, 'node_modules/@contextrail/code-review-agent/package.json'));
    if (
        pkg?.name !== '@contextrail/code-review-agent' ||
        pkg.version !== c.packageVersion ||
        pkg.bin?.['contextrail-review'] !== 'dist/cli.js'
    )
        fail('installed_package_invalid');
    copyFileSync(join(tool, 'package-lock.json'), join(e.REVIEW_ROOT, 'package-lock.json'));
    write(join(e.REVIEW_ROOT, 'setup-status.json'), { status: 'installed', package: pkg.name, version: pkg.version });
});
