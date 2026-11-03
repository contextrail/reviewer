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

function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [cli, ...args], {
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

    it.each([
        ['--max-parallel', '51', 'max-parallel must be 1..50.'],
        ['--source-read-bytes', '3', 'source-read-bytes must be >=4.'],
        ['--max-time-ms', '2147483648', 'Time limit exceeds the Node timer interval.'],
        ['--min-adherence', '3', 'min-adherence must be 0, 1 or 2.'],
        ['--feedback', 'sometimes', 'feedback must be send or off.'],
    ])('rejects invalid %s before repository/network work', (flag, value, message) => {
        const result = run(['review', ...comparison, flag, value]);
        expect(result.status).toBe(2);
        expect(result.stderr.trim()).toBe(message);
    });

    it.each([
        '{',
        '{"unexpected":{"provider":"openrouter","model":"fixture"}}',
        '{"assess":{"provider":"openrouter","model":"fixture","secret":"not-allowed"}}',
        '{"verify":{"provider":"invalid","model":"fixture"}}',
    ])('rejects malformed phase configuration without echoing it', (input) => {
        const result = run(['review', ...comparison, '--phase-models', input]);
        expect(result.status).toBe(2);
        expect(result.stderr.trim()).toBe(
            'phase-models must contain only plan/assess/verify provider/model/optional effort objects.',
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

    it('routes GitHub commands without falling through to review execution', () => {
        expect(run(['github', 'prepare']).stderr.trim()).toBe(
            'github prepare requires repository, pr-number, reviewer and output-dir.',
        );
        expect(run(['github', 'publish']).stderr.trim()).toBe('github publish requires run-dir and github-dir.');
        expect(run(['github', 'unknown']).stderr.trim()).toBe('Use github prepare or github publish.');
    });
});
