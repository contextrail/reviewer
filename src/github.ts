import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { digest, preparationManifest, type GitIdentity } from './prepare.js';
import { validatePhaseRecord } from './phases.js';
import { reconcileFindings, type ReviewFinding } from './assessment.js';
import {
    object,
    groupDeveloperFindings,
    developerFindingLocations,
    developerFindingGroupLabel,
    objects,
    string,
    markdownText,
    readHistory,
    renderReviewComment,
    renderActionSummary,
    reviewMarker,
    runRecord,
    summarizeUsage,
    withHistory,
    type HistoryConfiguration,
} from './presentation.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const githubInputSchema = z
    .object({
        version: z.literal(1),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        pr: z.number().int().positive(),
        reviewer: z.string().startsWith('skill://'),
        base: sha,
        head: sha,
        baseBranch: z.string().default(''),
        githubRun: z
            .string()
            .regex(/^[1-9][0-9]{0,19}$/)
            .optional(),
        githubAttempt: z.number().int().positive().optional(),
    })
    .strict();
type GitHubInput = z.infer<typeof githubInputSchema>;
type Requester = (path: string, method?: string, body?: unknown) => Promise<unknown>;
class GitHubAdapterError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}
const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) =>
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const fail = (code: string): never => {
    throw new GitHubAdapterError(code);
};
const validPath = (p: unknown): p is string =>
    typeof p === 'string' &&
    p.length > 0 &&
    !p.startsWith('/') &&
    !/\p{Cc}/u.test(p) &&
    !p
        .split('/')
        .some(
            (s) =>
                !s ||
                s === '.' ||
                s === '..' ||
                /^\.env(?:\.|$)|^(?:credentials|secrets)(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(s),
        );
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bot = (c: Record<string, unknown>) =>
    object(c.user).login === 'github-actions[bot]' && object(c.user).type === 'Bot';
function gitEnvironment(): NodeJS.ProcessEnv {
    return Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
    );
}
function git(repo: string | null, args: string[], token?: string): string {
    const env = {
        ...gitEnvironment(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        ...(token
            ? {
                  GIT_CONFIG_COUNT: '1',
                  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
              }
            : {}),
    };
    const out = spawnSync(
        'git',
        [
            '--no-pager',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            '-c',
            'credential.helper=',
            '-c',
            'protocol.file.allow=never',
            ...(repo ? ['-C', repo] : []),
            ...args,
        ],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (out.status !== 0) fail('git_operation_failed');
    return out.stdout;
}
async function readGitHubResponse(response: Response, method: string): Promise<unknown> {
    const failure = method === 'GET' ? 'github_read_failed' : 'github_write_unknown';
    const reader = response.body?.getReader();
    if (!reader) return fail(failure);
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) {
                await reader.cancel();
                fail('github_response_too_large');
            }
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
        return fail(failure);
    } finally {
        reader.releaseLock();
    }
}
export function githubRequester(repository: string, token: string, fetcher: typeof fetch = fetch): Requester {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) fail('github_configuration_invalid');
    return async (path, method = 'GET', body) => {
        if (path !== 'graphql' && (!path.startsWith('/') || path.startsWith('//') || path.split(/[/?]/).includes('..')))
            fail('github_path_invalid');
        let response: Response;
        try {
            response = await fetcher(
                path === 'graphql'
                    ? 'https://api.github.com/graphql'
                    : `https://api.github.com/repos/${repository}${path}`,
                {
                    method,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                    },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                    signal: AbortSignal.timeout(30000),
                    redirect: 'error',
                },
            );
        } catch {
            return fail(method === 'GET' ? 'github_read_failed' : 'github_write_unknown');
        }
        if (!response.ok) fail(method === 'GET' ? 'github_read_failed' : `github_write_${response.status}`);
        return readGitHubResponse(response, method);
    };
}
async function listAll(request: Requester, path: string, maxPages = 10): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= maxPages; page++) {
        const result = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Array.isArray(result)) throw new GitHubAdapterError('github_lookup_invalid');
        rows.push(...objects(result));
        if (result.length < 100) return rows;
    }
    return fail('github_lookup_incomplete');
}
export async function findReviewComment(
    c: HistoryConfiguration,
    request: Requester,
): Promise<Record<string, unknown> | null> {
    const candidates = (await listAll(request, `/issues/${c.pr}/comments`)).filter(
        (row) =>
            bot(row) &&
            typeof row.id === 'number' &&
            Number.isSafeInteger(row.id) &&
            row.id > 0 &&
            string(row.body).startsWith(reviewMarker(c) + '\n'),
    );
    return candidates.sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}
function sameComparison(pr: unknown, c: GitHubInput): boolean {
    const p = object(pr),
        base = object(p.base),
        head = object(p.head);
    return (
        p.number === c.pr &&
        object(base.repo).full_name === c.repository &&
        (!c.baseBranch || base.ref === c.baseBranch) &&
        base.sha === c.base &&
        head.sha === c.head
    );
}
const discussionQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){baseRefOid headRefOid comments(last:20){pageInfo{hasPreviousPage} nodes{id body url createdAt updatedAt author{login} authorAssociation}} reviews(last:10,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){pageInfo{hasPreviousPage} nodes{id body url submittedAt state author{login} authorAssociation}} dismissals:timelineItems(last:10,itemTypes:[REVIEW_DISMISSED_EVENT]){pageInfo{hasPreviousPage} nodes{... on ReviewDismissedEvent{id createdAt dismissalMessage actor{login} review{url}}}} reviewThreads(last:10){pageInfo{hasPreviousPage} nodes{id isResolved isOutdated path line resolvedBy{login} comments(last:5){pageInfo{hasPreviousPage} nodes{id body url createdAt updatedAt author{login} authorAssociation}}}}}}}`;
type ContextClip = (value: unknown, limit?: number) => string;
type DiscussionEntry = { kind: string; node: Record<string, unknown>; thread?: Record<string, unknown> };
function discussionEntries(node: Record<string, unknown>): { entries: DiscussionEntry[]; partial: boolean } {
    const entries: DiscussionEntry[] = [];
    let partial = false;
    for (const [key, kind] of [
        ['comments', 'comment'],
        ['reviews', 'review'],
    ]) {
        const connection = object(node[key!]);
        if (!Array.isArray(connection.nodes)) {
            partial = true;
            continue;
        }
        partial ||= !!object(connection.pageInfo).hasPreviousPage;
        entries.push(...objects(connection.nodes).map((entry) => ({ kind: kind!, node: entry })));
    }
    const threads = object(node.reviewThreads);
    if (!Array.isArray(threads.nodes)) partial = true;
    partial ||= !!object(threads.pageInfo).hasPreviousPage;
    for (const thread of objects(threads.nodes)) {
        const comments = object(thread.comments);
        partial ||= !!object(comments.pageInfo).hasPreviousPage;
        entries.push(...objects(comments.nodes).map((entry) => ({ kind: 'thread', node: entry, thread })));
    }
    const dismissals = object(node.dismissals);
    if (!Array.isArray(dismissals.nodes)) partial = true;
    partial ||= !!object(dismissals.pageInfo).hasPreviousPage;
    entries.push(
        ...objects(dismissals.nodes).map((entry) => ({
            kind: 'dismissal',
            node: {
                id: entry.id,
                body: entry.dismissalMessage ?? '',
                url: object(entry.review).url,
                createdAt: entry.createdAt,
                author: entry.actor,
                state: 'DISMISSED',
            },
        })),
    );
    return { entries, partial };
}
function discussionThread(thread: Record<string, unknown> | undefined, clip: ContextClip) {
    return {
        resolved: thread ? !!thread.isResolved : null,
        outdated: thread ? !!thread.isOutdated : null,
        resolvedBy: clip(object(thread?.resolvedBy).login, 100),
        path: clip(thread?.path, 500),
        line: Number.isSafeInteger(thread?.line) && Number(thread?.line) > 0 ? thread?.line : null,
    };
}
function discussionItem({ kind, node, thread }: DiscussionEntry, c: GitHubInput, clip: ContextClip) {
    if (typeof node.body !== 'string') return { item: null, partial: false };
    if (object(node.author).login === 'github-actions[bot]' && node.body.startsWith('<!-- contextrail-review:'))
        return { item: null, partial: false };
    const url = string(node.url);
    if (!url.startsWith(`https://github.com/${c.repository}/`)) return { item: null, partial: true };
    return {
        partial: node.body.length > 1000,
        item: {
            kind,
            id: clip(node.id, 200),
            author: clip(object(node.author).login, 100),
            association: clip(node.authorAssociation, 100),
            body: clip(node.body),
            url: clip(url),
            at: clip(node.updatedAt ?? node.submittedAt ?? node.createdAt, 50),
            state: clip(node.state, 50),
            ...discussionThread(thread, clip),
        },
    };
}
async function captureDiscussion(c: GitHubInput, request: Requester, clip: ContextClip, limitations: string[]) {
    try {
        const [owner, name] = c.repository.split('/');
        const raw = object(
            await request('graphql', 'POST', { query: discussionQuery, variables: { owner, name, number: c.pr } }),
        );
        const node = object(object(object(raw.data).repository).pullRequest);
        if (node.baseRefOid !== c.base || node.headRefOid !== c.head) fail('context_comparison_changed');
        const collected = discussionEntries(node),
            rows = collected.entries.map((entry) => discussionItem(entry, c, clip));
        const items = rows.flatMap(({ item }) => (item ? [item] : []));
        const partial =
            (Array.isArray(raw.errors) && raw.errors.length > 0) ||
            collected.partial ||
            rows.some((row) => row.partial) ||
            items.length > 80;
        if (partial)
            limitations.push(
                'Discussion is partial: recent bounded comments, reviews, dismissals and threads; at most 80 excerpts capped at 1000 characters.',
            );
        return { status: partial ? 'partial' : 'available', items: items.slice(-80) };
    } catch {
        limitations.push('PR discussion unavailable or comparison changed; no conversation completeness is claimed.');
        return { status: 'unavailable', items: [] };
    }
}
const unavailableChanges = (base: string | null, head: string) => ({
    status: 'unavailable',
    base,
    head,
    relation: 'unknown',
    files: [],
});
async function changesSincePrevious(
    previous: string | undefined,
    c: GitHubInput,
    request: Requester,
    clip: ContextClip,
    limitations: string[],
) {
    if (previous === c.head)
        return { status: 'same_head', base: previous, head: c.head, relation: 'identical', files: [] };
    if (!previous) return unavailableChanges(null, c.head);
    try {
        const comparison = object(await request(`/compare/${previous}...${c.head}?per_page=1`));
        if (
            !Array.isArray(comparison.files) ||
            !['ahead', 'behind', 'diverged', 'identical'].includes(string(comparison.status))
        )
            return fail('comparison_unavailable');
        const linear = !['behind', 'diverged'].includes(string(comparison.status));
        if (!linear)
            limitations.push(
                'Previous/current heads are not a linear forward increment; path comparison is not the full review.',
            );
        return {
            status: comparison.files.length > 100 || !linear ? 'partial' : 'available',
            base: previous,
            head: c.head,
            relation: comparison.status,
            files: objects(comparison.files)
                .slice(0, 100)
                .map((file) => ({ path: clip(file.filename, 500), status: clip(file.status, 50) })),
        };
    } catch {
        limitations.push('Changes since previous assessment are unavailable; current full comparison still applies.');
        return unavailableChanges(previous, c.head);
    }
}
async function retainedHistory(c: GitHubInput, request: Requester, includeHistory: boolean, limitations: string[]) {
    if (!includeHistory) return null;
    try {
        return readHistory((await findReviewComment(c, request))?.body, c);
    } catch {
        limitations.push('Bot comment history could not be completely read.');
        return null;
    }
}
// Metadata receipts only: no check output, annotations, logs, URLs or status descriptions.
async function captureObservedChecks(c: GitHubInput, request: Requester, clip: ContextClip) {
    const checkRuns = async () => {
        try {
            const raw = object(await request(`/commits/${c.head}/check-runs?filter=latest&per_page=50`));
            if (!Array.isArray(raw.check_runs) || !Number.isInteger(raw.total_count) || Number(raw.total_count) < 0)
                return { status: 'unavailable', items: [] };
            const rows = objects(raw.check_runs);
            const valid = rows.filter(
                (row) =>
                    row.head_sha === c.head &&
                    typeof row.name === 'string' &&
                    typeof row.status === 'string' &&
                    (row.conclusion === null || typeof row.conclusion === 'string'),
            );
            return {
                status:
                    Number(raw.total_count) !== rows.length ||
                    rows.length > 50 ||
                    valid.length !== raw.check_runs.length
                        ? 'partial'
                        : 'available',
                items: valid.slice(0, 50).map((row) => ({
                    name: clip(row.name, 200),
                    status: clip(row.status, 50),
                    conclusion: row.conclusion === null ? null : clip(row.conclusion, 50),
                })),
            };
        } catch {
            return { status: 'unavailable', items: [] };
        }
    };
    const commitStatuses = async () => {
        try {
            const raw = object(await request(`/commits/${c.head}/status?per_page=50`));
            if (
                raw.sha !== c.head ||
                !Array.isArray(raw.statuses) ||
                !Number.isInteger(raw.total_count) ||
                Number(raw.total_count) < 0
            )
                return { status: 'unavailable', items: [] };
            const rows = objects(raw.statuses);
            const valid = rows.filter((row) => typeof row.context === 'string' && typeof row.state === 'string');
            return {
                status:
                    Number(raw.total_count) !== rows.length || rows.length > 50 || valid.length !== raw.statuses.length
                        ? 'partial'
                        : 'available',
                items: valid
                    .slice(0, 50)
                    .map((row) => ({ context: clip(row.context, 200), state: clip(row.state, 50) })),
            };
        } catch {
            return { status: 'unavailable', items: [] };
        }
    };
    const [checks, statuses] = await Promise.all([checkRuns(), commitStatuses()]);
    return {
        source: 'github_api',
        head: c.head,
        capturedAt: new Date().toISOString(),
        checkRuns: checks,
        commitStatuses: statuses,
    };
}
// The Action context script loads this public entry dynamically through loadReviewerModule.
export async function collectGitHubContext(
    c: GitHubInput,
    pr: unknown,
    request: Requester,
    includeHistory: boolean,
    token = '',
): Promise<Record<string, unknown>> {
    const p = object(pr),
        limitations = [
            'PR discussions and hidden bot state are mutable, untrusted data, not permission, approval or proof of a fix.',
        ];
    if (string(p.title).length > 1000) limitations.push('PR title truncated to 1000 characters.');
    if (string(p.body).length > 20000)
        limitations.push('PR body truncated to 20000 characters; omitted intent was not supplied.');
    const clip: ContextClip = (value, limit = 1000) => {
        let text = string(value).replace(/\p{Cc}/gu, ' ');
        if (token.length >= 8) text = text.split(token).join('[REDACTED]');
        return text.slice(0, limit);
    };
    const history = await retainedHistory(c, request, includeHistory, limitations),
        previous = history?.assessment?.head;
    const context: Record<string, unknown> = {
        version: 2,
        repository: c.repository,
        pr: c.pr,
        reviewer: c.reviewer,
        capturedAt: new Date().toISOString(),
        comparison: { base: c.base, head: c.head },
        intent: { title: clip(p.title, 1000), body: clip(p.body, 20000), source: 'github_pull_request' },
        observedChecks: await captureObservedChecks(c, request, clip),
        history: history
            ? { status: 'available', runs: history.runs, omitted: history.omitted, assessment: history.assessment }
            : { status: 'unavailable', runs: [], omitted: 0, assessment: null },
        discussion: { status: 'unavailable', items: [] },
        changesSincePrevious: unavailableChanges(previous ?? null, c.head),
        limitations,
    };
    if (!history) limitations.push('No valid retained history is available; earlier reviews may exist.');
    if (!includeHistory) {
        limitations.push('Discussion/history collection was not requested.');
        return context;
    }
    context.discussion = await captureDiscussion(c, request, clip, limitations);
    context.changesSincePrevious = await changesSincePrevious(previous, c, request, clip, limitations);
    if (Buffer.byteLength(JSON.stringify(context)) > 200 * 1024) {
        context.discussion = { status: 'unavailable', items: [] };
        limitations.push('Discussion omitted to keep contextual input within 200 KiB.');
    }
    if (Buffer.byteLength(JSON.stringify(context)) > 200 * 1024) {
        context.changesSincePrevious = unavailableChanges(previous ?? null, c.head);
        limitations.push('Changed-path details omitted to keep contextual input within 200 KiB.');
    }
    return context;
}
function createComparisonCheckout(outputDir: string, c: GitHubInput, token?: string) {
    const root = resolve(outputDir);
    if (existsSync(root)) {
        const stat = lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('unsafe_output_directory');
    } else mkdirSync(root, { recursive: true, mode: 0o700 });
    const repository = join(realpathSync(root), 'comparison');
    if (existsSync(repository)) fail('comparison_directory_exists');
    git(null, ['init', '--template=', repository]);
    git(repository, ['remote', 'add', 'origin', `https://github.com/${c.repository}.git`]);
    git(
        repository,
        [
            'fetch',
            '--no-tags',
            '--no-recurse-submodules',
            'origin',
            c.base,
            `refs/pull/${c.pr}/head:refs/contextrail/review-head`,
        ],
        token,
    );
    if (git(repository, ['rev-parse', '--verify', 'refs/contextrail/review-head^{commit}']).trim() !== c.head)
        fail('superseded_comparison');
    for (const commit of [c.base, c.head])
        if (git(repository, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit)
            fail('fixed_commit_invalid');
    return { root, repository };
}
export async function prepareGitHubReview(options: {
    repository: string;
    prNumber: number;
    reviewer: string;
    outputDir: string;
    baseBranch?: string;
    collectPrContext?: boolean;
    fixed?: { base: string; head: string };
    token?: string;
    fetch?: typeof fetch;
}) {
    const request = githubRequester(options.repository, options.token ?? process.env.GITHUB_TOKEN ?? '', options.fetch);
    const pr = object(await request(`/pulls/${options.prNumber}`));
    const c = githubInputSchema.parse({
        version: 1,
        repository: options.repository,
        pr: options.prNumber,
        reviewer: options.reviewer,
        base: options.fixed?.base ?? string(object(pr.base).sha),
        head: options.fixed?.head ?? string(object(pr.head).sha),
        baseBranch: options.baseBranch ?? '',
        ...(process.env.GITHUB_RUN_ID
            ? { githubRun: process.env.GITHUB_RUN_ID, githubAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) }
            : {}),
    });
    if (!sameComparison(pr, c)) fail('ineligible_pr');
    const { root, repository } = createComparisonCheckout(
        options.outputDir,
        c,
        options.token ?? process.env.GITHUB_TOKEN,
    );
    if (!sameComparison(await request(`/pulls/${c.pr}`), c)) fail('superseded_comparison');
    write(join(root, 'github-input.json'), c);
    write(join(root, 'comparison.json'), {
        base: c.base,
        head: c.head,
        repository: c.repository,
        pr: c.pr,
        freshness: 'current_before_review',
    });
    const context = await collectGitHubContext(
        c,
        pr,
        request,
        !!options.collectPrContext,
        options.token ?? process.env.GITHUB_TOKEN ?? '',
    );
    write(join(root, 'pr-context.json'), context);
    return {
        exitCode: 0,
        directory: root,
        repository,
        base: c.base,
        head: c.head,
        prContextPath: join(root, 'pr-context.json'),
    };
}
type DiffAnchors = Map<string, Set<number>>;
export function parseDiffAnchors(diff: string): DiffAnchors {
    const anchors: DiffAnchors = new Map();
    let oldPath = '',
        newPath = '',
        oldLine = 0,
        newLine = 0,
        inHunk = false;
    const add = (path: string, side: string, line: number) => {
        if (!validPath(path) || line < 1) return;
        const key = `${path}\0${side}`;
        const set = anchors.get(key) ?? new Set();
        set.add(line);
        anchors.set(key, set);
    };
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            oldPath = '';
            newPath = '';
            inHunk = false;
        } else if (line.startsWith('--- ')) {
            oldPath = line.slice(4).replace(/^a\//, '');
            inHunk = false;
        } else if (line.startsWith('+++ ')) {
            newPath = line.slice(4).replace(/^b\//, '');
            inHunk = false;
        } else if (line.startsWith('@@ ')) {
            const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (h) {
                oldLine = Number(h[1]);
                newLine = Number(h[2]);
                inHunk = true;
            }
        } else if (inHunk && line.startsWith('-')) {
            add(oldPath, 'LEFT', oldLine++);
        } else if (inHunk && line.startsWith('+')) {
            add(newPath, 'RIGHT', newLine++);
        } else if (inHunk && line.startsWith(' ')) {
            add(oldPath, 'LEFT', oldLine++);
            add(newPath, 'RIGHT', newLine++);
        }
    }
    return anchors;
}
export type InlineComment = {
    path: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
    body: string;
};
type SourceText = { blob: string; text: string };
type InlineOptions = {
    diff: string;
    source: (side: 'base' | 'head', path: string) => SourceText;
    existingComments?: unknown[];
    max?: number;
};
type InlineContext = {
    state: Record<string, unknown>;
    evidence: Record<string, unknown>;
    entries: Record<string, unknown>[];
    reviewer: Record<string, unknown>;
    anchors: DiffAnchors;
    source: InlineOptions['source'];
    seen: Set<string>;
    occupied: Map<string, Array<[number, number]>>;
};
type InlineLocation = { path: string; side: 'LEFT' | 'RIGHT'; line: number; source: SourceText };
type InlineResult = { comment?: InlineComment; omitted: number; duplicates: number };
const diffSide = (side: unknown): 'LEFT' | 'RIGHT' | null =>
    side === 'base' ? 'LEFT' : side === 'head' ? 'RIGHT' : null;
const findingMarker = /<!-- contextrail-finding:([a-f0-9]{64}) -->/;
const inlineClassification = (finding: Record<string, unknown>) =>
    ['binding_violation', 'behavioral_defect'].includes(string(finding.classification));
const publishableFinding = (finding: Record<string, unknown>) =>
    finding.verified === true && inlineClassification(finding);
const sortedJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en');
const findingIds = (finding: Record<string, unknown>, key: string): unknown[] =>
    Array.isArray(finding[key]) ? finding[key] : [];

function coversRange(anchors: DiffAnchors, path: string, start: number, end: number): boolean {
    return Array.from({ length: end - start + 1 }, (_, i) => start + i).every((line) =>
        anchors.get(`${path}\0RIGHT`)?.has(line),
    );
}
function existingSuggestionRange(comment: Record<string, unknown>, currentHead: string) {
    if (!bot(comment) || !findingMarker.test(string(comment.body)) || !string(comment.body).includes('```suggestion\n'))
        return null;
    if (
        comment.commit_id !== currentHead ||
        comment.side !== 'RIGHT' ||
        (comment.start_side && comment.start_side !== 'RIGHT')
    )
        return null;
    const path = string(comment.path),
        start = Number(comment.start_line ?? comment.line),
        end = Number(comment.line);
    if (!validPath(path) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
        return null;
    return { path, start, end };
}
function occupyExistingSuggestion(raw: unknown, context: InlineContext, currentHead: string): void {
    const range = existingSuggestionRange(object(raw), currentHead);
    if (!range) return;
    const { path, start, end } = range;
    try {
        const before = context
            .source('head', path)
            .text.split('\n')
            .slice(start - 1, end);
        if (before.length !== end - start + 1 || !coversRange(context.anchors, path, start, end)) return;
        const occupied = context.occupied.get(path) ?? [];
        occupied.push([start, end]);
        context.occupied.set(path, occupied);
    } catch {
        // Unreadable source cannot establish a current suggestion range.
        return;
    }
}
function inlineContext(input: unknown, evidenceInput: unknown, options: InlineOptions): InlineContext {
    const state = object(input);
    const context: InlineContext = {
        state,
        evidence: object(evidenceInput),
        entries: objects(state.entries),
        reviewer: object(state.reviewer),
        anchors: parseDiffAnchors(options.diff),
        source: options.source,
        seen: new Set(),
        occupied: new Map(),
    };
    const currentHead = string(object(object(state.artifact).head).commit);
    for (const raw of options.existingComments ?? []) {
        const comment = object(raw);
        if (bot(comment)) {
            const marker = string(comment.body).match(findingMarker);
            if (marker) context.seen.add(marker[1]!);
        }
        occupyExistingSuggestion(raw, context, currentHead);
    }
    return context;
}
function quoteMatches(source: SourceText, line: number, column: number, quote: string): boolean {
    return (
        Number.isSafeInteger(column) &&
        column >= 0 &&
        !!quote &&
        source.text
            .split('\n')
            .slice(line - 1)
            .join('\n')
            .slice(column)
            .startsWith(quote)
    );
}
function accountCitationMatches(citation: Record<string, unknown>, context: InlineContext): boolean {
    const provenance = object(citation.provenance),
        location = object(citation.location);
    const side = provenance.side === 'base' ? 'base' : provenance.side === 'head' ? 'head' : null;
    const path = string(provenance.path),
        line = Number(location.line),
        column = Number(location.column);
    if (provenance.kind !== 'source' || !side || !validPath(path) || !Number.isSafeInteger(line) || line < 1)
        return false;
    if (provenance.commit !== object(object(context.state.artifact)[side]).commit) return false;
    try {
        const current = context.source(side, path),
            lines = current.text.split('\n');
        return (
            provenance.object === current.blob &&
            line <= lines.length &&
            column <= lines[line - 1]!.length &&
            quoteMatches(current, line, column, string(citation.quote))
        );
    } catch {
        return false;
    }
}
function compareCitations(a: Record<string, unknown>, b: Record<string, unknown>): number {
    const ap = object(a.provenance),
        bp = object(b.provenance),
        al = object(a.location),
        bl = object(b.location);
    return (
        string(ap.path).localeCompare(string(bp.path), 'en') ||
        string(ap.side).localeCompare(string(bp.side), 'en') ||
        Number(al.line) - Number(bl.line) ||
        Number(al.column) - Number(bl.column) ||
        string(a.quote).localeCompare(string(b.quote), 'en')
    );
}
function groupedInlineFinding(accounts: Record<string, unknown>[]): Record<string, unknown> {
    const first = accounts[0]!;
    if (accounts.length === 1) return first;
    return {
        ...first,
        locationRefs: accounts.flatMap((account) => objects(account.locationRefs)).sort(compareCitations),
        assessmentIds: [...new Set(accounts.flatMap((account) => findingIds(account, 'assessmentIds')))].sort(),
        checkIds: [...new Set(accounts.flatMap((account) => findingIds(account, 'checkIds')))].sort(),
        findingId: accounts.map((account) => string(account.findingId)).sort(),
        proposedReplacement: accounts.every(
            (account) =>
                object(account.proposedReplacement).verified === true &&
                digest(account.proposedReplacement) === digest(first.proposedReplacement),
        )
            ? first.proposedReplacement
            : null,
    };
}
function inlineLocation(citation: Record<string, unknown>, context: InlineContext): InlineLocation | null {
    const record = object(context.evidence[string(citation.ref)]);
    const provenance = object(citation.provenance ?? record.provenance),
        location = object(citation.location);
    const path = string(provenance.path),
        side = diffSide(provenance.side);
    const line = Number(location.line ?? object(provenance.start).line);
    if (
        provenance.kind !== 'source' ||
        !validPath(path) ||
        !side ||
        !Number.isSafeInteger(line) ||
        !context.anchors.get(`${path}\0${side}`)?.has(line)
    )
        return null;
    try {
        const source = context.source(side === 'LEFT' ? 'base' : 'head', path);
        if (
            string(provenance.object ?? provenance.blob) !== source.blob ||
            !quoteMatches(source, line, Number(location.column ?? 0), string(citation.quote))
        )
            return null;
        return { path, side, line, source };
    } catch {
        return null;
    }
}
function criterionReferences(finding: Record<string, unknown>, entries: Record<string, unknown>[]): unknown[] {
    return findingIds(finding, 'assessmentIds')
        .map((id) => {
            const entry = entries.find((entry) => entry.assessmentId === id);
            return entry ? { nodeId: entry.nodeId, version: entry.version, contentHash: entry.contentHash } : id;
        })
        .sort(sortedJson);
}
function inlineFingerprint(
    finding: Record<string, unknown>,
    context: InlineContext,
    location: { path: string; side: string; line: number; blob: unknown },
    classification: unknown,
): string {
    return hash({
        reviewer: context.reviewer.nodeId,
        criteria: criterionReferences(finding, context.entries),
        findingId: finding.findingId,
        checkIds: [...findingIds(finding, 'checkIds')].sort(),
        classification,
        path: location.path,
        blob: location.blob,
        side: location.side,
        line: location.line,
    });
}
function accountPreviouslyPosted(account: Record<string, unknown>, context: InlineContext): boolean {
    return objects(account.locationRefs).some((citation) => {
        const provenance = object(citation.provenance),
            location = object(citation.location);
        const path = string(provenance.path),
            line = Number(location.line);
        const side = diffSide(provenance.side);
        if (!side || !context.anchors.get(`${path}\0${side}`)?.has(line)) return false;
        return context.seen.has(
            inlineFingerprint(account, context, { path, line, side, blob: provenance.object }, account.classification),
        );
    });
}
function inlineAccountText(
    account: Record<string, unknown>,
    index: number,
    grouped: boolean,
    entries: Record<string, unknown>[],
): string {
    const criteria = findingIds(account, 'assessmentIds')
        .map((id) => {
            const entry = entries.find((entry) => entry.assessmentId === id);
            return markdownText(entry ? `${entry.nodeId} @ ${entry.version}` : id, 600);
        })
        .join(', ');
    return `${grouped ? `Verified account ${index + 1}: ` : ''}**${markdownText(account.classification)}**\n\n${markdownText(account.explanation, 1500)}\n\nCriterion: ${criteria}.\n\nConsequence: ${markdownText(account.consequence, 800)}\n\nCorrection: ${markdownText(account.correction, 1200)}${grouped ? `\n\nLocation: ${markdownText(developerFindingLocations(account), 1500)}.\n\nAccount: ${markdownText(account.findingId, 200)}.` : ''}`;
}
function inlineBody(
    accounts: Record<string, unknown>[],
    finding: Record<string, unknown>,
    fingerprint: string,
    context: InlineContext,
): string {
    const criterionText = criterionReferences(finding, context.entries)
        .map((ref) => {
            const entry = object(ref);
            return markdownText(typeof ref === 'string' ? ref : `${entry.nodeId} @ ${entry.version}`, 600);
        })
        .join(', ');
    const accountText = accounts
        .map((account, index) => inlineAccountText(account, index, accounts.length > 1, context.entries))
        .join('\n\n---\n\n');
    return `<!-- contextrail-finding:${fingerprint} -->\n${accounts.length > 1 ? `**${accounts.length} verified accounts at ${developerFindingGroupLabel(accounts)}.**\n\nCriteria: ${criterionText}.\n\n` : ''}${accountText}`;
}
function replacementRange(replacement: Record<string, unknown>): { start: number; end: number; text: string } | null {
    const start = Number(replacement.startLine),
        end = Number(replacement.endLine),
        text = replacement.replacement;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > 20)
        return null;
    if (typeof text !== 'string' || text.split('\n').length > 20 || text.includes('```')) return null;
    return { start, end, text };
}
function applyInlineSuggestion(
    comment: InlineComment,
    finding: Record<string, unknown>,
    source: SourceText,
    context: InlineContext,
): void {
    const replacement = object(finding.proposedReplacement),
        range = replacementRange(replacement);
    if (
        comment.side !== 'RIGHT' ||
        replacement.verified !== true ||
        replacement.path !== comment.path ||
        replacement.blob !== source.blob ||
        !range
    )
        return;
    const { start, end, text } = range,
        occupied = context.occupied.get(comment.path) ?? [];
    if (
        replacement.before !==
            source.text
                .split('\n')
                .slice(start - 1, end)
                .join('\n') ||
        !coversRange(context.anchors, comment.path, start, end) ||
        occupied.some(([a, b]) => a <= end && b >= start)
    )
        return;
    comment.line = end;
    if (start !== end) {
        comment.start_line = start;
        comment.start_side = 'RIGHT';
    }
    comment.body += `\n\nSource-verified suggestion; tests were not executed.\n\n\`\`\`suggestion\n${text}\n\`\`\``;
    occupied.push([start, end]);
    context.occupied.set(comment.path, occupied);
}
function inlineForGroup(accounts: Record<string, unknown>[], context: InlineContext, remaining: number): InlineResult {
    // A shared range never grants another account's quotations source authority.
    if (
        accounts.length > 1 &&
        !accounts.every((account) =>
            objects(account.locationRefs).every((citation) => accountCitationMatches(citation, context)),
        )
    )
        return { omitted: accounts.length, duplicates: 0 };
    const finding = groupedInlineFinding(accounts);
    if (!publishableFinding(finding)) return { omitted: 1, duplicates: 0 };
    const classification =
        accounts.length === 1
            ? finding.classification
            : accounts.map((account) => [account.findingId, account.classification]).sort(sortedJson);
    for (const citation of objects(finding.locationRefs ?? finding.citations)) {
        const location = inlineLocation(citation, context);
        if (!location) continue;
        const { path, side, line, source } = location;
        const fingerprint = inlineFingerprint(
            finding,
            context,
            { path, blob: source.blob, side, line },
            classification,
        );
        if (
            context.seen.has(fingerprint) ||
            (accounts.length > 1 && accounts.every((account) => accountPreviouslyPosted(account, context)))
        )
            return { omitted: 0, duplicates: 1 };
        context.seen.add(fingerprint);
        if (remaining <= 0) return { omitted: 1, duplicates: 0 };
        const body = inlineBody(accounts, finding, fingerprint, context);
        if (Buffer.byteLength(body) > 60000) return { omitted: 1, duplicates: 0 };
        const comment: InlineComment = { path, line, side, body };
        applyInlineSuggestion(comment, finding, source, context);
        return { comment, omitted: 0, duplicates: 0 };
    }
    return { omitted: 1, duplicates: 0 };
}
export function buildInlineReview(
    input: unknown,
    evidenceInput: unknown,
    options: InlineOptions,
): { comments: InlineComment[]; omitted: number; duplicates: number } {
    const context = inlineContext(input, evidenceInput, options),
        candidates = objects(context.state.findings);
    const comments: InlineComment[] = [];
    let omitted = candidates.filter((finding) => !publishableFinding(finding)).length,
        duplicates = 0;
    for (const accounts of groupDeveloperFindings(candidates.filter(inlineClassification))) {
        const result = inlineForGroup(accounts, context, (options.max ?? 20) - comments.length);
        omitted += result.omitted;
        duplicates += result.duplicates;
        if (result.comment) comments.push(result.comment);
    }
    return { comments, omitted, duplicates };
}
type PublicationHandoffs = {
    proposals: Map<string, Record<string, unknown>>;
    verifications: Map<string, Record<string, unknown>>;
    proposalOrigins: Map<string, { ref: string; hash: string }>;
    verificationOrigins: Map<string, ReturnType<typeof validatePhaseRecord>>;
};
function publicationManifest(runDir: string, state: Record<string, unknown>, statePath: string) {
    const manifest = object(json(join(runDir, 'manifest.json'))),
        files = object(manifest.files);
    if (
        state.schemaVersion !== 2 ||
        manifest.contractVersion !== 1 ||
        manifest.runId !== state.runId ||
        manifest.scopeIdentity !== state.scopeIdentity ||
        digest(manifest.artifact) !== digest(object(state.artifact)) ||
        !Object.keys(files).length
    )
        fail('publication_manifest_invalid');
    if (!files[statePath.slice(resolve(runDir).length + 1)]) fail('publication_report_unbound');
    return { manifest, files };
}
function verifyManifestFiles(runDir: string, files: Record<string, unknown>): void {
    for (const [name, expected] of Object.entries(files)) {
        if (
            !/^(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|phases\/[A-Za-z0-9_-]+\.json)$/.test(name) ||
            !/^sha256:[a-f0-9]{64}$/.test(string(expected))
        )
            fail('publication_manifest_path_invalid');
        const file = join(runDir, name),
            stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (name === 'diff.patch' ? 16 : 8) * 1024 * 1024)
            fail('publication_artifact_invalid');
        if (`sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}` !== expected)
            fail('publication_artifact_changed');
    }
}
function verifyManifestScope(manifest: Record<string, unknown>, state: Record<string, unknown>): unknown[] {
    const expected = objects(manifest.entries).map((entry) => entry.assessmentId),
        actual = objects(state.entries).map((entry) => entry.assessmentId);
    if (
        new Set(expected).size !== expected.length ||
        new Set(actual).size !== actual.length ||
        expected.length !== actual.length ||
        expected.some((id) => !actual.includes(id))
    )
        fail('publication_scope_changed');
    return actual;
}
function verifyPhaseInputs(
    record: ReturnType<typeof validatePhaseRecord>,
    runDir: string,
    files: Record<string, unknown>,
    preparedHash: string,
    seen: Map<string, string>,
): void {
    if (
        !record.inputRefs.some((input) => input.ref === 'manifest.json' && input.hash === preparedHash) ||
        !record.inputRefs.some(
            (input) =>
                input.ref === 'publications.json' && input.hash === digest(json(join(runDir, 'publications.json'))),
        )
    )
        fail('publication_phase_inputs_missing');
    for (const input of record.inputRefs) {
        if (input.ref === 'manifest.json' && input.hash !== preparedHash) fail('publication_phase_manifest_changed');
        if (
            input.ref === 'publications.json' &&
            (!files['publications.json'] || input.hash !== digest(json(join(runDir, 'publications.json'))))
        )
            fail('publication_phase_publications_changed');
        if (input.ref.startsWith('phase:') && seen.get(input.ref) !== input.hash)
            fail('publication_phase_chain_changed');
    }
}
function retainAssessment(record: ReturnType<typeof validatePhaseRecord>, handoffs: PublicationHandoffs): void {
    for (const id of record.assessmentIds) {
        handoffs.proposals.delete(id);
        handoffs.verifications.delete(id);
        handoffs.proposalOrigins.delete(id);
        handoffs.verificationOrigins.delete(id);
    }
    if (record.status !== 'complete') return;
    for (const proposal of objects(record.output)) {
        const id = string(object(proposal.result).assessmentId);
        if (!record.assessmentIds.includes(id)) fail('publication_foreign_assessment');
        handoffs.proposals.set(id, proposal);
        handoffs.proposalOrigins.set(id, {
            ref: `phase:${record.phase}:${record.workUnitId}:${record.attempt}`,
            hash: digest(record),
        });
    }
}
function retainVerification(record: ReturnType<typeof validatePhaseRecord>, handoffs: PublicationHandoffs): void {
    for (const id of record.assessmentIds) {
        handoffs.verifications.delete(id);
        handoffs.verificationOrigins.delete(id);
    }
    if (record.status !== 'complete') return;
    for (const entry of objects(record.output)) {
        const id = string(entry.assessmentId);
        if (!record.assessmentIds.includes(id)) fail('publication_foreign_verification');
        handoffs.verifications.set(id, entry);
        handoffs.verificationOrigins.set(id, record);
    }
}
function publicationHandoffs(
    runDir: string,
    state: Record<string, unknown>,
    manifest: Record<string, unknown>,
    files: Record<string, unknown>,
): PublicationHandoffs {
    const preparedHash = digest(preparationManifest(manifest)),
        seen = new Map<string, string>();
    const handoffs: PublicationHandoffs = {
        proposals: new Map(),
        verifications: new Map(),
        proposalOrigins: new Map(),
        verificationOrigins: new Map(),
    };
    for (const raw of objects(state.phases)) {
        const record = validatePhaseRecord(raw, {
            runId: string(state.runId),
            artifact: object(state.artifact) as GitIdentity,
            scopeIdentity: typeof state.scopeIdentity === 'string' ? state.scopeIdentity : null,
            assessmentIds: Array.isArray(raw.assessmentIds) ? (raw.assessmentIds as string[]) : [],
            requireComplete: false,
        });
        const filename =
            record.phase === 'plan' && record.workUnitId === 'all' && record.attempt === 1
                ? 'plan.json'
                : `${record.phase}-${record.workUnitId}-${record.attempt}.json`;
        const name = `phases/${filename}`;
        if (!files[name] || digest(json(join(runDir, name))) !== digest(raw)) fail('publication_phase_changed');
        verifyPhaseInputs(record, runDir, files, preparedHash, seen);
        seen.set(`phase:${record.phase}:${record.workUnitId}:${record.attempt}`, digest(record));
        if (record.phase === 'assess') retainAssessment(record, handoffs);
        if (record.phase === 'verify') retainVerification(record, handoffs);
    }
    return handoffs;
}
function acceptedOriginalFindings(id: string, handoffs: PublicationHandoffs): ReviewFinding[] {
    const proposal = handoffs.proposals.get(id),
        verification = handoffs.verifications.get(id);
    const origin = handoffs.proposalOrigins.get(id),
        verifier = handoffs.verificationOrigins.get(id);
    if (!verification) return [];
    if (!proposal || !origin || !verifier?.inputRefs.some((ref) => ref.ref === origin.ref && ref.hash === origin.hash))
        return fail('publication_stale_verification');
    if (verification.amendment) return objects(object(verification.amendment).findings) as unknown as ReviewFinding[];
    return objects(proposal.findings).flatMap((original) => {
        const decision = objects(verification.findings).find((finding) => finding.findingId === original.findingId);
        if (decision?.accepted !== true) return [];
        // The assessed finding was validated before being committed to the checked phase record.
        return [
            {
                ...original,
                verified: true,
                proposedReplacement: original.proposedReplacement
                    ? { ...object(original.proposedReplacement), verified: decision.suggestionAccepted === true }
                    : undefined,
            } as unknown as ReviewFinding,
        ];
    });
}
function verifyPublishedJudgments(
    state: Record<string, unknown>,
    handoffs: PublicationHandoffs,
    actualIds: unknown[],
): void {
    // Report flags and unions are not authority: reconstruct from immutable phase handoffs.
    const originals = objects(state.entries).flatMap((entry) =>
        acceptedOriginalFindings(string(entry.assessmentId), handoffs),
    );
    const canonical = reconcileFindings(originals),
        reported = objects(state.findings).filter((finding) => finding.verified === true);
    if (canonical.length !== reported.length) fail('publication_finding_unverified');
    for (const finding of reported) {
        const expected = canonical.find((original) => original.findingId === finding.findingId);
        if (!expected || digest(expected) !== digest(finding)) fail('publication_finding_unverified');
    }
    for (const entry of objects(state.entries)) {
        const resolution = handoffs.verifications.get(string(entry.assessmentId))?.resolution;
        if (resolution && digest(resolution) !== digest(entry.result)) fail('publication_resolution_changed');
    }
    if (
        object(state.verification).complete === true &&
        actualIds.some((id) => {
            const verdict = handoffs.verifications.get(string(id));
            return verdict?.disposition !== 'accept' && object(verdict?.resolution).assessmentId !== id;
        })
    )
        fail('publication_coverage_unverified');
}
/** Validate caller-controlled retained records before using their judgments for a privileged write.
 * Hashes detect changed material; they do not authenticate a caller able to replace the whole bundle. */
export function validatePublicationArtifacts(runDir: string, state: Record<string, unknown>, statePath: string): void {
    const { manifest, files } = publicationManifest(runDir, state, statePath);
    verifyManifestFiles(runDir, files);
    const actualIds = verifyManifestScope(manifest, state);
    const handoffs = publicationHandoffs(runDir, state, manifest, files);
    verifyPublishedJudgments(state, handoffs, actualIds);
}
type PublishOptions = {
    runDir: string;
    githubDir: string;
    postComment?: boolean;
    inlineComments?: boolean;
    summaryFile?: string;
    artifactUrl?: string;
    dryRun?: boolean;
    token?: string;
    fetch?: typeof fetch;
};
type InlinePlan = { inline: ReturnType<typeof buildInlineReview>; status: string; exitCode: number };
function loadPublicationState(options: PublishOptions, c: GitHubInput): Record<string, unknown> {
    const reportFile = join(options.runDir, 'report.json'),
        stateFile = join(options.runDir, 'state.json');
    const state = object(existsSync(reportFile) ? json(reportFile) : existsSync(stateFile) ? json(stateFile) : null);
    if (!Object.keys(state).length) return state;
    const artifact = object(state.artifact);
    if (
        object(artifact.base).commit !== c.base ||
        object(artifact.head).commit !== c.head ||
        object(state.reviewer).nodeId !== c.reviewer ||
        typeof state.runId !== 'string'
    )
        fail('publication_identity_mismatch');
    validatePublicationArtifacts(
        resolve(options.runDir),
        state,
        existsSync(reportFile) ? resolve(reportFile) : resolve(stateFile),
    );
    return state;
}
function publicationPresentation(options: PublishOptions, c: GitHubInput) {
    const failedStage = ['setup', 'comparison', 'context', 'review', 'evidence'].find((stage) => {
        const path = join(options.githubDir, `${stage}-status.json`);
        return existsSync(path) && object(json(path)).status === 'failed';
    });
    return {
        failedStage,
        artifactUrl: options.artifactUrl,
        runUrl: c.githubRun ? `https://github.com/${c.repository}/actions/runs/${c.githubRun}` : undefined,
    };
}
function publicationRunRecord(options: PublishOptions, c: GitHubInput, state: Record<string, unknown>) {
    if (!c.githubRun) return null;
    const usage = summarizeUsage(state),
        statusFile = join(options.githubDir, 'review-status.json');
    return runRecord(
        { ...c, githubRun: c.githubRun, githubAttempt: c.githubAttempt ?? 1 },
        c,
        state,
        object(state.decision).exitCode ?? (existsSync(statusFile) ? object(json(statusFile)).exit : null),
        usage.cost.value,
        usage.cost.complete,
    );
}
function commentWithRetainedHistory(
    body: string,
    previous: Record<string, unknown> | null,
    localRecord: ReturnType<typeof publicationRunRecord>,
    c: GitHubInput,
    state: Record<string, unknown>,
): string {
    if (localRecord) return withHistory(body, previous, localRecord, c);
    const prior = readHistory(previous?.body, c);
    const history = {
        version: 2,
        repository: c.repository,
        pr: c.pr,
        reviewer: c.reviewer,
        runs: prior?.runs ?? [],
        omitted: prior?.omitted ?? 0,
        assessment: prior?.assessment ?? null,
    };
    return `${reviewMarker(c)}\n<!-- contextrail-local-run:${hash({ runId: state.runId, base: c.base, head: c.head, scope: state.scopeIdentity })} -->\n<!-- contextrail-state:v2:${Buffer.from(JSON.stringify(history)).toString('base64')} -->\n${body}`;
}
async function publicationFreshness(
    previous: Record<string, unknown> | null,
    c: GitHubInput,
    request: Requester,
): Promise<string | null> {
    const old = string(previous?.body).match(/<!-- contextrail-run:([1-9][0-9]*):([1-9][0-9]*) -->/);
    if (
        old &&
        c.githubRun &&
        (BigInt(old[1]!) > BigInt(c.githubRun) || (old[1] === c.githubRun && Number(old[2]) > (c.githubAttempt ?? 1)))
    )
        return 'skipped_newer';
    return sameComparison(await request(`/pulls/${c.pr}`), c) ? null : 'skipped_superseded';
}
function snapshotInlineOptions(
    state: Record<string, unknown>,
    c: GitHubInput,
    existingComments: unknown[],
): InlineOptions {
    const repository = string(object(state.artifact).repository);
    return {
        diff: git(repository, [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--find-renames',
            '--unified=3',
            '--no-color',
            c.base,
            c.head,
            '--',
        ]),
        source: (side, path) => {
            if (!validPath(path)) return fail('invalid_inline_path');
            const commit = side === 'base' ? c.base : c.head;
            const blob = git(repository, ['rev-parse', '--verify', `${commit}:${path}`]).trim();
            if (!/^[a-f0-9]{40}$/.test(blob)) return fail('invalid_inline_blob');
            return { blob, text: git(repository, ['cat-file', 'blob', blob]) };
        },
        existingComments,
    };
}
async function inlinePublicationPlan(
    options: PublishOptions,
    c: GitHubInput,
    state: Record<string, unknown>,
    request: Requester | null,
): Promise<InlinePlan> {
    const empty = { comments: [], omitted: 0, duplicates: 0 };
    if (!options.inlineComments) return { inline: empty, status: 'disabled', exitCode: 0 };
    let existing: unknown[] = [];
    if (request) {
        try {
            existing = await listAll(request, `/pulls/${c.pr}/comments`);
        } catch {
            return { inline: empty, status: 'unknown', exitCode: 2 };
        }
    }
    const snapshot = snapshotInlineOptions(state, c, existing);
    const inline = buildInlineReview(state, json(join(options.runDir, 'evidence.json')), snapshot);
    return {
        inline,
        status: options.dryRun ? 'preview' : inline.comments.length ? 'pending' : 'no_new_findings',
        exitCode: 0,
    };
}
function reviewRunMarker(c: GitHubInput, state: Record<string, unknown>): string {
    return `<!-- contextrail-review-run:${hash({ repository: c.repository, pr: c.pr, base: c.base, head: c.head, scopeIdentity: state.scopeIdentity, runId: state.runId, workflowRun: c.githubRun, attempt: c.githubAttempt })} -->`;
}
function writePublicationPayloads(
    options: PublishOptions,
    c: GitHubInput,
    state: Record<string, unknown>,
    body: string,
    inline: InlinePlan['inline'],
): void {
    write(join(options.runDir, 'publication-payloads.json'), {
        comment: { body },
        review: {
            commit_id: c.head,
            event: 'COMMENT',
            body: `${reviewRunMarker(c, state)}\nContextRail governed review for ${c.head}. ${inline.omitted} findings retained in the main report without a new inline thread.`,
            comments: inline.comments,
        },
        preview: !!options.dryRun,
        limitations: options.dryRun
            ? ['Current GitHub freshness and prior-thread lookup were not performed in dry-run.']
            : [],
    });
}
async function deliverMainComment(
    request: Requester,
    c: GitHubInput,
    previous: Record<string, unknown> | null,
    body: string,
) {
    try {
        if (!sameComparison(await request(`/pulls/${c.pr}`), c))
            return { status: 'skipped_superseded', url: '', exitCode: 0 };
        const result = object(
            await request(
                previous ? `/issues/comments/${previous.id}` : `/issues/${c.pr}/comments`,
                previous ? 'PATCH' : 'POST',
                { body },
            ),
        );
        if (!Number.isSafeInteger(result.id) || Number(result.id) < 1) fail('github_write_unknown');
        return {
            status: previous ? 'updated' : 'created',
            url: `https://github.com/${c.repository}/pull/${c.pr}#issuecomment-${result.id}`,
            exitCode: 0,
        };
    } catch {
        return { status: 'unknown', url: '', exitCode: 2 };
    }
}
async function deliverInlineReview(
    request: Requester,
    c: GitHubInput,
    state: Record<string, unknown>,
    inline: InlinePlan['inline'],
) {
    try {
        if (!sameComparison(await request(`/pulls/${c.pr}`), c)) return { status: 'skipped_superseded', exitCode: 0 };
        const result = object(
            await request(`/pulls/${c.pr}/reviews`, 'POST', {
                commit_id: c.head,
                event: 'COMMENT',
                body: `${reviewRunMarker(c, state)}\nContextRail governed findings at ${c.head}.`,
                comments: inline.comments,
            }),
        );
        if (!Number.isSafeInteger(result.id)) fail('github_write_unknown');
        return { status: 'posted', exitCode: 0 };
    } catch {
        return { status: 'unknown', exitCode: 2 };
    }
}
function publicationRequest(options: PublishOptions, c: GitHubInput): Requester | null {
    if (options.dryRun || !options.postComment) return null;
    return githubRequester(c.repository, options.token ?? process.env.GITHUB_TOKEN ?? '', options.fetch);
}
export async function publishGitHubReview(options: PublishOptions) {
    if (options.inlineComments && !options.postComment) fail('inline_requires_comment');
    const c = githubInputSchema.parse(json(join(options.githubDir, 'github-input.json')));
    const state = loadPublicationState(options, c),
        presentation = publicationPresentation(options, c);
    const summary = renderActionSummary(state, presentation);
    if (options.summaryFile) appendFileSync(options.summaryFile, summary);
    const localRecord = publicationRunRecord(options, c, state);
    const output = {
        exitCode: 0,
        status: 'rendered',
        commentStatus: 'disabled',
        inlineStatus: 'disabled',
        omittedInline: 0,
        duplicateInline: 0,
        commentUrl: '',
    };
    const save = () => {
        write(join(options.runDir, 'publication.json'), output);
        return output;
    };
    let body = renderReviewComment(state, presentation),
        previous: Record<string, unknown> | null = null;
    const request = publicationRequest(options, c);
    if (request) {
        previous = await findReviewComment(c, request);
        const skipped = await publicationFreshness(previous, c, request);
        if (skipped) {
            output.status = skipped;
            return save();
        }
    }
    body = commentWithRetainedHistory(body, previous, localRecord, c, state);
    const plan = await inlinePublicationPlan(options, c, state, request),
        inline = plan.inline;
    let inlineStatus = plan.status,
        commentStatus = 'disabled',
        exitCode = plan.exitCode;
    if (options.inlineComments)
        body = body.replace(
            '<summary>Run details</summary>',
            `<summary>Run details</summary>\n\nInline feedback plan: ${inline.comments.length} new comments; ${inline.duplicates} existing threads; ${inline.omitted} findings retained without a new inline comment. Delivery outcome is recorded in the Action summary and publication artifact.`,
        );
    writePublicationPayloads(options, c, state, body, inline);
    if (request) {
        const delivery = await deliverMainComment(request, c, previous, body);
        if (delivery.status === 'skipped_superseded') {
            output.status = delivery.status;
            return save();
        }
        commentStatus = delivery.status;
        output.commentUrl = delivery.url;
        exitCode = Math.max(exitCode, delivery.exitCode);
        if (options.inlineComments && inlineStatus === 'pending' && commentStatus !== 'unknown') {
            const delivered = await deliverInlineReview(request, c, state, inline);
            inlineStatus = delivered.status;
            exitCode = Math.max(exitCode, delivered.exitCode);
        }
    }
    Object.assign(output, {
        exitCode,
        status: options.dryRun ? 'preview' : exitCode ? 'delivery_incomplete' : request ? 'published' : 'rendered',
        commentStatus,
        inlineStatus,
        omittedInline: inline.omitted,
        duplicateInline: inline.duplicates,
    });
    return save();
}
