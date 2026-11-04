import process from 'node:process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { config, e, fail, gitEnvironment, guarded, output, read, write } from './common.mjs';

function reviewArguments(c, fixed) {
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
        '--enforcement',
        c.enforcement || 'advisory',
        '--feedback',
        c.feedback,
    ];
    if (c.phaseModels && Object.keys(c.phaseModels).length) args.push('--phase-models', JSON.stringify(c.phaseModels));
    if (c.logLevel) args.push('--log-level', c.logLevel);
    if (e.PR_CONTEXT_PATH) {
        if (e.PR_CONTEXT_PATH !== join(e.REVIEW_ROOT, 'pr-context.json')) fail('invalid_configuration');
        args.push('--pr-context', e.PR_CONTEXT_PATH);
    }
    if (c.effort) args.push('--effort', c.effort);
    if (c.repositoryAttribution) args.push('--repository-attribution');
    return args;
}
function reviewEnvironment(c) {
    const providers = new Set([c.provider, ...Object.values(c.phaseModels ?? {}).map((p) => p.provider)]);
    return {
        ...gitEnvironment(),
        CONTEXTRAIL_MCP_URL: c.mcpUrl,
        CONTEXTRAIL_MCP_ORG_ID: c.org,
        CONTEXTRAIL_MCP_AUTH_TOKEN: e.CONTEXTRAIL_MCP_AUTH_TOKEN,
        ...(providers.has('openai') ? { OPENAI_API_KEY: e.OPENAI_API_KEY } : {}),
        ...(providers.has('openrouter') ? { OPENROUTER_API_KEY: e.OPENROUTER_API_KEY } : {}),
    };
}
await guarded('review', async () => {
    const c = config(),
        fixed = read(join(e.REVIEW_ROOT, 'comparison.json'));
    if (!fixed) fail('configuration_unavailable');
    const providerKey = c.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
    if (!e.CONTEXTRAIL_MCP_AUTH_TOKEN || !e[providerKey]) fail('review_credentials_missing');
    const args = reviewArguments(c, fixed);
    const stdout = openSync(join(e.REVIEW_ROOT, 'cli-stdout.log'), 'w', 0o600);
    const stderr = openSync(join(e.REVIEW_ROOT, 'cli-stderr.log'), 'w', 0o600);
    const child = spawn(process.execPath, args, {
        cwd: join(e.REVIEW_ROOT, 'tool'),
        env: reviewEnvironment(c),
        stdio: ['ignore', stdout, 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
        writeSync(stderr, chunk);
        process.stderr.write(chunk);
    });
    child.once('close', () => closeSync(stderr));
    closeSync(stdout);

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
