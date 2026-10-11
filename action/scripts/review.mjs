import process from 'node:process';
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { config, e, fail, gitEnvironment, guarded, output, read, write } from './common.mjs';

await guarded('review', async () => {
    const c = config(),
        fixed = read(join(e.REVIEW_ROOT, 'comparison.json'));
    if (!fixed) fail('configuration_unavailable');
    const providerKey = c.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
    if (!e.CONTEXTRAIL_MCP_AUTH_TOKEN || !e[providerKey]) fail('review_credentials_missing');
    const args = [
        join(e.REVIEW_ROOT, 'tool/node_modules/@contextrail/code-review-agent/dist/cli.js'),
        'review',
        '--reviewer',
        c.reviewer,
        '--repo',
        join(e.REVIEW_ROOT, 'comparison'),
        '--base',
        fixed.base,
        '--head',
        fixed.head,
        '--provider',
        c.provider,
        '--model',
        c.model,
        '--max-time-ms',
        c.maxTimeMs,
        '--feedback',
        c.feedback,
    ];
    if (c.effort) args.push('--effort', c.effort);
    if (c.repositoryAttribution) args.push('--repository-attribution');
    const stdout = openSync(join(e.REVIEW_ROOT, 'cli-stdout.log'), 'w', 0o600);
    const stderr = openSync(join(e.REVIEW_ROOT, 'cli-stderr.log'), 'w', 0o600);
    const child = spawn(process.execPath, args, {
        cwd: join(e.REVIEW_ROOT, 'tool'),
        env: {
            ...gitEnvironment(),
            CONTEXTRAIL_MCP_URL: c.mcpUrl,
            CONTEXTRAIL_MCP_ORG_ID: c.org,
            CONTEXTRAIL_MCP_AUTH_TOKEN: e.CONTEXTRAIL_MCP_AUTH_TOKEN,
            [providerKey]: e[providerKey],
        },
        stdio: ['ignore', stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward('SIGINT'),
        terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const exit = await new Promise((resolve) => {
        child.once('error', () => resolve(null));
        child.once('close', (code) => resolve(code));
    });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (![0, 1, 2].includes(exit)) fail('review_execution_failed');
    output('exit', exit);
    write(join(e.REVIEW_ROOT, 'review-status.json'), { exit });
    process.exitCode = exit;
});
