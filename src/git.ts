import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export function passiveGitEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
    return {
        ...env,
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        LC_ALL: 'C',
    };
}

function git(repository: string, args: string[]): string {
    return execFileSync(
        'git',
        [
            '--no-pager',
            '--no-lazy-fetch',
            '--no-replace-objects',
            '-c',
            'core.fsmonitor=false',
            '-C',
            repository,
            ...args,
        ],
        {
            encoding: 'utf8',
            env: passiveGitEnvironment(),
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    ).trim();
}
export type RepositoryEnvironment =
    | { status: 'reported'; provider: string; owner: string; name: string }
    | { status: 'unavailable'; reason: 'no_remote' | 'ambiguous_remote' | 'not_determined' };

export function fixGitIdentity(repository: string, base: string, head: string) {
    const root = realpathSync(git(repository, ['rev-parse', '--show-toplevel']));
    const resolve = (ref: string) => git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    const baseCommit = resolve(base);
    const headCommit = resolve(head);
    return {
        kind: 'git_comparison' as const,
        repository: root,
        repositoryEnvironment: repositoryEnvironment(root),
        base: { suppliedRef: base, commit: baseCommit, tree: git(root, ['rev-parse', `${baseCommit}^{tree}`]) },
        head: { suppliedRef: head, commit: headCommit, tree: git(root, ['rev-parse', `${headCommit}^{tree}`]) },
        limitations: [
            'Only the fixed commits identify the artifact. Working-tree and index changes are excluded. Source retrieval does not establish semantic coverage or evaluate assessments.',
        ],
    };
}
function optionalGit(root: string, args: string[]): string | undefined {
    try {
        return git(root, args) || undefined;
    } catch {
        return undefined;
    }
}
export function repositoryEnvironment(root: string): RepositoryEnvironment {
    const remotes = optionalGit(root, ['remote'])?.split('\n') ?? [];
    const branch = optionalGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const tracked = branch ? optionalGit(root, ['config', '--get', `branch.${branch}.remote`]) : undefined;
    const selected =
        tracked && tracked !== '.' && remotes.includes(tracked)
            ? tracked
            : remotes.includes('origin')
              ? 'origin'
              : remotes.length === 1
                ? remotes[0]
                : undefined;
    if (!selected) return { status: 'unavailable', reason: remotes.length ? 'ambiguous_remote' : 'no_remote' };
    return parseRepositoryRemote(optionalGit(root, ['remote', 'get-url', selected]));
}

/** Parse attribution independently of Git discovery; no URL normalization repairs. */
export function parseRepositoryRemote(remote: string | undefined): RepositoryEnvironment {
    try {
        if (!remote) throw new Error();
        const address = remote.includes('://')
            ? remote
            : remote.replace(/^(?:[^@/:]+@)?([^/:]+):(.+)$/u, 'ssh://$1/$2');
        const url = new URL(address);
        if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) throw new Error();
        // Preserve the original namespace: URL.pathname silently resolves dot segments.
        const parsed = address.match(/^[^:]+:\/\/([^/?#]*)(\/[^?#]*)?/u);
        const host = parsed?.[1]?.replace(/^.*@/u, '').replace(/:\d*$/u, '').toLowerCase();
        if (host !== url.hostname.toLowerCase()) throw new Error();
        const parts = (parsed?.[2] ?? '')
            .replace(/^\/+|\/+$/gu, '')
            .replace(/\.git$/u, '')
            .split('/');
        const name = parts.pop();
        const provider = url.hostname.toLowerCase();
        const owner = parts.join('/');
        // Match v2-core's reportedEnvironmentSchema without an unpublished runtime dependency.
        // Regression tests validate these emitted values against that maintained schema.
        if (
            provider.length > 253 ||
            !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(provider) ||
            owner.length > 200 ||
            !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(owner) ||
            parts.some((part) => part === '.' || part === '..') ||
            !name ||
            name.length > 100 ||
            !/^[A-Za-z0-9._-]+$/u.test(name) ||
            name === '.' ||
            name === '..' ||
            name.endsWith('.git')
        )
            throw new Error();
        return { status: 'reported', provider, owner, name };
    } catch {
        return { status: 'unavailable', reason: 'not_determined' };
    }
}
