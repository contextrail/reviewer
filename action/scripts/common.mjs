import process from 'node:process';
import { error as logError } from 'node:console';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const e = process.env;
export const read = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};
export const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
export const output = (key, value) => {
    if (String(value).includes('\n') || String(value).includes('\r')) throw new Error('invalid_output');
    appendFileSync(e.GITHUB_OUTPUT, `${key}=${value}\n`);
};
export const fail = (code) => {
    throw new Error(code);
};
export const config = () => read(join(e.REVIEW_ROOT, 'config.json')) ?? fail('configuration_unavailable');
// Subprocesses receive an allowlist, never ambient credentials, npm/Git config or CLI policy overrides.
export const runtimeEnvironment = () =>
    Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].filter((key) => e[key]).map((key) => [key, e[key]]));
export const gitEnvironment = () => ({
    ...runtimeEnvironment(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
});
export const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? '');
export function eligible(pr, c) {
    return (
        pr?.state === 'open' &&
        pr.number === c.pr &&
        pr.base?.ref === c.baseBranch &&
        pr.base?.repo?.full_name === c.repository &&
        pr.head?.repo?.full_name === c.repository &&
        pr.user?.type === 'User' &&
        ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association) &&
        sha(pr.base?.sha) &&
        sha(pr.head?.sha)
    );
}
export async function currentPR(c) {
    if (!e.GH_READ_TOKEN) fail('github_token_missing');
    const response = await globalThis.fetch(`https://api.github.com/repos/${c.repository}/pulls/${c.pr}`, {
        headers: {
            Authorization: `Bearer ${e.GH_READ_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: globalThis.AbortSignal.timeout(30000),
        redirect: 'error',
    });
    if (!response.ok) fail('github_read_failed');
    return response.json();
}
export async function guarded(stage, fn) {
    try {
        await fn();
    } catch (error) {
        // Never echo arbitrary exception text, upstream responses, commands or credentials.
        const codes = [
            'package_version_missing',
            'invalid_package_version',
            'configuration_unavailable',
            'github_token_missing',
            'github_read_failed',
            'ineligible_pr',
            'superseded_comparison',
            'git_fetch_failed',
            'fixed_commit_invalid',
            'review_credentials_missing',
            'review_execution_failed',
            'package_install_failed',
            'installed_package_invalid',
            'event_rejected',
            'event_comparison_invalid',
            'invalid_configuration',
        ];
        const code = codes.includes(error?.message) ? error.message : `${stage}_failed`;
        if (e.REVIEW_ROOT) write(join(e.REVIEW_ROOT, `${stage}-status.json`), { status: 'failed', code });
        const help = ['package_version_missing', 'invalid_package_version'].includes(code)
            ? ' Configure package-version with a qualified exact published npm version; there is no source fallback.'
            : '';
        logError(
            `::error::ContextRail ${stage}: ${code}.${help} No success is implied; inspect the summary and available evidence.`,
        );
        process.exitCode = 2;
    }
}
