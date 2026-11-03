import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export const MAX_PREPARATION_BYTES = 16 * 1024 * 1024;

export function sensitiveGitPath(path: string): boolean {
    return path
        .split('/')
        .some((part) => /^\.env(?:\.|$)|^(?:credentials|secrets)(?:\.|$)|\.(?:pem|key|p12|pfx)$/iu.test(part));
}

function readableDiffLimits(
    artifact: ReturnType<typeof fixGitIdentity>,
    options: { timeoutMs?: number; maxBytes?: number },
) {
    const timeout = options.timeoutMs ?? 30_000;
    const maxBuffer = options.maxBytes ?? MAX_PREPARATION_BYTES;
    for (const side of ['base', 'head'] as const)
        for (const object of [artifact[side].commit, artifact[side].tree])
            if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object)) throw new Error('readable_diff_invalid_identity');
    if (
        !Number.isSafeInteger(timeout) ||
        timeout < 1 ||
        timeout > 2_147_483_647 ||
        !Number.isSafeInteger(maxBuffer) ||
        maxBuffer < 1
    )
        throw new Error('readable_diff_invalid_limit');
    return { timeout, maxBuffer };
}

/** Ordinary unified Git output, bounded as one complete artifact; never a model transformation. */
export function readableDiff(
    artifact: ReturnType<typeof fixGitIdentity>,
    options: { timeoutMs?: number; maxBytes?: number } = {},
) {
    const { timeout, maxBuffer } = readableDiffLimits(artifact, options);
    const deadline = Date.now() + timeout;
    const run = (args: string[]) => {
        try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('readable_diff_deadline');
            return execFileSync(
                'git',
                [
                    '--no-pager',
                    '--no-lazy-fetch',
                    '--no-replace-objects',
                    '--literal-pathspecs',
                    `--attr-source=${artifact.head.tree}`,
                    '-c',
                    'core.fsmonitor=false',
                    '-c',
                    'core.attributesFile=/dev/null',
                    '-c',
                    'diff.renameLimit=0',
                    '-C',
                    artifact.repository,
                    ...args,
                ],
                { env: passiveGitEnvironment(), timeout: remaining, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] },
            );
        } catch {
            throw new Error('readable_diff_unavailable_or_limit_exceeded');
        }
    };
    const decode = (value: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(value);
    const actualTrees = decode(
        run(['rev-parse', `${artifact.base.commit}^{tree}`, `${artifact.head.commit}^{tree}`]),
    ).trim();
    if (actualTrees !== `${artifact.base.tree}\n${artifact.head.tree}`)
        throw new Error('readable_diff_identity_changed');
    const common = [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-relative',
        '--find-renames=50%',
        '-O/dev/null',
    ];
    const revisions = [artifact.base.commit, artifact.head.commit];
    const records = decode(run([...common, '--name-status', '-z', ...revisions, '--'])).split('\0');
    const files: string[] = [];
    const excludedPaths: string[] = [];
    for (let index = 0; index < records.length - 1;) {
        const status = records[index++]!;
        const paths = [records[index++]!];
        if (/^[RC]/u.test(status)) paths.push(records[index++]!);
        if (paths.some((path) => !path)) throw new Error('readable_diff_invalid_name_record');
        (paths.some(sensitiveGitPath) ? excludedPaths : files).push(...paths);
    }
    const eligible = [...new Set(files)].sort();
    const omitted = [...new Set(excludedPaths)].sort();
    const patch = eligible.length
        ? decode(run([...common, '--src-prefix=a/', '--dst-prefix=b/', ...revisions, '--', ...eligible]))
        : '';
    const stat = eligible.length ? decode(run([...common, '--stat', ...revisions, '--', ...eligible])) : '';
    return { patch, stat, files: eligible, excludedPaths: omitted };
}

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
function assertRemoteCoordinates(
    provider: string,
    owner: string,
    parts: string[],
    name: string | undefined,
): asserts name is string {
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
}

function remoteCoordinates(address: string, url: URL): RepositoryEnvironment {
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
    assertRemoteCoordinates(provider, owner, parts, name);
    return { status: 'reported', provider, owner, name };
}

export function parseRepositoryRemote(remote: string | undefined): RepositoryEnvironment {
    try {
        if (!remote) throw new Error();
        const address = remote.includes('://')
            ? remote
            : remote.replace(/^(?:[^@/:]+@)?([^/:]+):(.+)$/u, 'ssh://$1/$2');
        const url = new URL(address);
        if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) throw new Error();
        return remoteCoordinates(address, url);
    } catch {
        return { status: 'unavailable', reason: 'not_determined' };
    }
}
