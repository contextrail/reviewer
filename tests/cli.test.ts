import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const comparison = [
    '--reviewer',
    'skill://test/reviewer',
    '--repo',
    '/__contextrail_cli_missing_repository__',
    '--base',
    'HEAD',
    '--head',
    'HEAD',
];
const unresolvedGit = 'Cannot resolve repository and base/head references to Git commits.';

function run(args: string[], env: Record<string, string> = {}, nodeArgs: string[] = []) {
    return spawnSync(process.execPath, [...nodeArgs, cli, ...args], {
        encoding: 'utf8',
        timeout: 10_000,
        // Deliberately omit local credentials/configuration: these are offline CLI boundary tests.
        env: {
            PATH: process.env.PATH,
            CONTEXTRAIL_REVIEW_PROVIDER: 'openrouter',
            CONTEXTRAIL_REVIEW_MODEL: 'fixture-model',
            ...env,
        },
    });
}

describe('CLI configuration boundaries', () => {
    it('renders help and version before validating review configuration', () => {
        const help = run(['--help'], { CONTEXTRAIL_REVIEW_PROVIDER: 'invalid' });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('--resume');
        expect(run(['--version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('keeps explicit provider settings ahead of environment settings', () => {
        const result = run(['review', ...comparison, '--provider', 'openrouter', '--model', 'explicit-model'], {
            CONTEXTRAIL_REVIEW_PROVIDER: 'invalid',
            CONTEXTRAIL_REVIEW_MODEL: '',
        });
        expect(result.status).toBe(2);
        expect(result.stderr.trim()).toBe(unresolvedGit);
    });

    it.each(['advisory', 'required', 'strict'])('accepts %s from CLI and environment with CLI precedence', (mode) => {
        expect(run(['review', ...comparison], { CONTEXTRAIL_REVIEW_ENFORCEMENT: mode }).stderr.trim()).toBe(
            unresolvedGit,
        );
        expect(
            run(['review', ...comparison, '--enforcement', mode], {
                CONTEXTRAIL_REVIEW_ENFORCEMENT: 'invalid',
            }).stderr.trim(),
        ).toBe(unresolvedGit);
    });
    it('rejects obsolete policy environment rather than silently changing enforcement', () => {
        const result = run(['review', ...comparison], { CONTEXTRAIL_REVIEW_ADVISORY: 'false' });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('was replaced by CONTEXTRAIL_REVIEW_ENFORCEMENT');
    });

    it.each([
        ['--source-read-bytes', '3', 'source-read-bytes must be >=4.'],
        ['--max-time-ms', '2147483648', 'Time limit exceeds the Node timer interval.'],
        ['--enforcement', 'sometimes', 'enforcement must be advisory, required or strict.'],
        ['--feedback', 'sometimes', 'feedback must be send or off.'],
    ])('rejects invalid %s before repository/network work', (flag, value, message) => {
        const result = run(['review', ...comparison, flag, value]);
        expect(result.status).toBe(2);
        expect(result.stderr.trim()).toBe(message);
    });

    it.each([
        '{',
        '{"plan":{"provider":"openrouter","model":"fixture"}}',
        '{"unexpected":{"provider":"openrouter","model":"fixture"}}',
        '{"assess":{"provider":"openrouter","model":"fixture","secret":"not-allowed"}}',
        '{"verify":{"provider":"invalid","model":"fixture"}}',
    ])('rejects malformed phase configuration without echoing it', (input) => {
        const result = run(['review', ...comparison, '--phase-models', input]);
        expect(result.status).toBe(2);
        expect(result.stderr.trim()).toBe(
            'phase-models must contain only assess/verify provider/model/optional effort objects.',
        );
    });

    it('accepts complete phase overrides and retains preparation-only behavior', () => {
        const phases = JSON.stringify({ assess: { provider: 'openrouter', model: 'fixture', effort: 'medium' } });
        expect(run(['review', ...comparison, '--phase-models', phases]).stderr.trim()).toBe(unresolvedGit);
        expect(run(['prepare', ...comparison], { CONTEXTRAIL_REVIEW_PROVIDER: 'invalid' }).stderr.trim()).toBe(
            unresolvedGit,
        );
        expect(run(['prepare', ...comparison, '--resume', 'saved-run']).stderr.trim()).toBe(
            '--resume is only valid for review.',
        );
    });

    it.each([
        ['EACCES', 'filesystem_permission_denied'],
        ['ENOSPC', 'filesystem_storage_full'],
        ['ENOENT', 'filesystem_path_missing'],
        ['ECONNRESET', 'transport_failed'],
        ['UNRECOGNIZED_PRIVATE_CODE', 'command_failed'],
    ])('reports bounded %s preparation failures without leaking exception contents', (code, expected) => {
        const preload = `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
fs.mkdir = async () => { throw Object.assign(new Error('private source and secret-token'), { code: ${JSON.stringify(code)}, path: '/private/customer/file' }); };
syncBuiltinESMExports();`;
        const result = run(
            [
                'prepare',
                '--reviewer',
                'skill://test/reviewer',
                '--repo',
                fileURLToPath(new URL('../', import.meta.url)),
                '--base',
                'HEAD',
                '--head',
                'HEAD',
            ],
            {
                CONTEXTRAIL_MCP_URL: 'https://example.invalid/mcp',
                CONTEXTRAIL_MCP_AUTH_TOKEN: 'fixture-token',
                CONTEXTRAIL_MCP_ORG_ID: 'fixture',
            },
            ['--import', `data:text/javascript,${encodeURIComponent(preload)}`],
        );
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        const failure = JSON.parse(result.stderr.trim());
        expect(failure).toMatchObject({ kind: 'cli_failed', data: { stage: 'preparation', code: expected } });
        if (code === 'ECONNRESET') expect(failure.data.transport).toBe('connection_reset');
        expect(result.stderr).not.toContain('private');
        expect(result.stderr).not.toContain('secret-token');
        expect(result.stderr).not.toContain('UNRECOGNIZED_PRIVATE_CODE');
    });

    it('routes GitHub commands without falling through to review execution', () => {
        expect(run(['github', 'prepare']).stderr.trim()).toBe(
            'github prepare requires repository, pr-number, reviewer and output-dir.',
        );
        expect(run(['github', 'publish']).stderr.trim()).toBe('github publish requires run-dir and github-dir.');
        expect(run(['github', 'unknown']).stderr.trim()).toBe('Use github prepare or github publish.');
    });
});
