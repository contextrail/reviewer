import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { passiveGitEnvironment } from './git.js';
import type { GitIdentity } from './prepare.js';

export type SourceSide = 'base' | 'head';
export type Snapshot = { side: SourceSide; commit: string; tree: string };
export type SourceEntry = Snapshot & {
    path: string;
    object: string;
    mode: string;
    kind: 'file' | 'symlink' | 'submodule';
};
export type SourceChange = {
    kind: 'addition' | 'modification' | 'deletion' | 'rename' | 'type_change';
    base: SourceEntry | null;
    head: SourceEntry | null;
    similarity: number | null;
};
export type SourceLimits = {
    pageEntries: number;
    searchMatches: number;
    searchFiles: number;
    readLines: number;
    readBytes: number;
    timeoutMs: number;
};
/** Provisional response/operation defaults, never total-source capacity limits. */
export const DEFAULT_SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({
    pageEntries: 100,
    searchMatches: 100,
    searchFiles: 100,
    readLines: 200,
    readBytes: 65_536,
    timeoutMs: 30_000,
});
export class SourceAccessError extends Error {
    constructor(
        readonly code: 'invalid_input' | 'invalid_cursor' | 'cancelled' | 'timeout' | 'unavailable',
        message: string,
    ) {
        super(message);
    }
}
type Page<T, C> = { status: 'complete' | 'truncated'; items: T[]; next: C | null };
export type SourcePosition = { line: number; column: number };
export type ReadRequest = { side: SourceSide; path: string; start?: SourcePosition; endLine?: number };
export type ReadResult = {
    snapshot: Snapshot;
    entry: SourceEntry | null;
    status: 'complete' | 'truncated' | 'unavailable' | 'unsupported';
    reason?: string;
    fragments: Array<{ line: number; column: number; text: string }>;
    next: ReadRequest | null;
};
export type SearchCursor = { scope: string; entryOffset: number; characterOffset: number };
export type SourceMatch = { entry: SourceEntry; line: number; column: number; endColumn: number };
export type SearchResult = Page<SourceMatch, SearchCursor> & {
    snapshot: Snapshot;
    path: string | null;
    scannedFiles: number;
    skipped: Array<{ entry: SourceEntry; reason: string }>;
    evidence: 'literal_navigation_only';
};
type Control = { signal?: AbortSignal };
type Operation = { signal: AbortSignal; check: () => void };

function integer(value: number, name: string, minimum = 1) {
    if (!Number.isSafeInteger(value) || value < minimum)
        throw new SourceAccessError('invalid_input', `${name} must be a safe integer >= ${minimum}.`);
}
function safePath(path: string) {
    if (
        typeof path !== 'string' ||
        !path ||
        path.includes('\0') ||
        path.startsWith('/') ||
        path.split('/').some((p) => !p || p === '.' || p === '..')
    )
        throw new SourceAccessError(
            'invalid_input',
            'path must be an exact repository-relative Git path without dot segments.',
        );
}
function kind(mode: string): SourceEntry['kind'] {
    return mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
}

/** Passive committed-object access. Does not write state or evaluate guidance. */
export class FixedSnapshotSource {
    readonly limits: Readonly<SourceLimits>;
    private readonly artifact: GitIdentity;
    constructor(artifact: GitIdentity, overrides: Partial<SourceLimits> = {}) {
        // Copy identities: caller mutation cannot move an existing accessor.
        this.artifact = structuredClone(artifact);
        for (const side of ['base', 'head'] as const) {
            for (const id of [artifact[side].commit, artifact[side].tree]) {
                if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id))
                    throw new SourceAccessError('invalid_input', 'Captured revisions must be full Git object IDs.');
            }
        }
        this.limits = Object.freeze({ ...DEFAULT_SOURCE_LIMITS, ...overrides });
        for (const [name, value] of Object.entries(this.limits)) integer(value, name, name === 'readBytes' ? 4 : 1);
        if (this.limits.timeoutMs > 2_147_483_647)
            throw new SourceAccessError('invalid_input', 'timeoutMs exceeds the Node timer interval.');
    }
    private snapshot(side: SourceSide): Snapshot {
        if (side !== 'base' && side !== 'head')
            throw new SourceAccessError('invalid_input', 'side must be base or head.');
        return { side, commit: this.artifact[side].commit, tree: this.artifact[side].tree };
    }
    private async operation<T>(control: Control, body: (operation: Operation) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        const deadline = Date.now() + this.limits.timeoutMs;
        let timedOut = false;
        const cancel = () => controller.abort();
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.limits.timeoutMs);
        control.signal?.addEventListener('abort', cancel, { once: true });
        const check = () => {
            if (control.signal?.aborted)
                throw new SourceAccessError('cancelled', 'Source operation cancelled by caller; no complete result.');
            if (timedOut || Date.now() >= deadline)
                throw new SourceAccessError('timeout', 'Source operation timed out; no complete result.');
        };
        try {
            check();
            const operation = { signal: controller.signal, check };
            let trees = '';
            for await (const chunk of this.git(
                ['rev-parse', `${this.artifact.base.commit}^{tree}`, `${this.artifact.head.commit}^{tree}`],
                operation,
            ))
                trees += chunk.toString('ascii');
            if (trees.trim() !== `${this.artifact.base.tree}\n${this.artifact.head.tree}`)
                throw new SourceAccessError(
                    'unavailable',
                    'Captured commits and trees do not agree or are unavailable.',
                );
            const result = await body(operation);
            check();
            return result;
        } catch (error) {
            check();
            throw error;
        } finally {
            clearTimeout(timer);
            control.signal?.removeEventListener('abort', cancel);
        }
    }
    private async *git(args: string[], operation: Operation): AsyncGenerator<Buffer> {
        operation.check();
        const child = spawn(
            'git',
            [
                '--no-pager',
                '--no-lazy-fetch',
                '--no-replace-objects',
                `--attr-source=${this.artifact.head.tree}`,
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.attributesFile=/dev/null',
                '-C',
                this.artifact.repository,
                ...args,
            ],
            {
                env: passiveGitEnvironment(),
                stdio: ['ignore', 'pipe', 'ignore'],
            },
        );
        const closed = new Promise<number | null>((resolve, reject) => {
            child.once('error', () => reject(new SourceAccessError('unavailable', 'Git could not start.')));
            child.once('close', resolve);
        });
        // Attach immediately so an early spawn failure cannot become an unhandled rejection.
        void closed.catch(() => undefined);
        const stop = () => child.kill('SIGKILL');
        operation.signal.addEventListener('abort', stop, { once: true });
        try {
            if (operation.signal.aborted) stop();
            for await (const chunk of child.stdout) {
                operation.check();
                yield chunk as Buffer;
            }
            operation.check();
            if ((await closed) !== 0)
                throw new SourceAccessError(
                    'unavailable',
                    'Pinned Git object/repository unavailable, or Git lacks required passive options (Git >=2.45).',
                );
        } finally {
            operation.signal.removeEventListener('abort', stop);
            if (child.exitCode === null) child.kill('SIGKILL');
            await closed.catch(() => undefined);
        }
    }
    private async *records(args: string[], operation: Operation) {
        let pending = Buffer.alloc(0);
        for await (const chunk of this.git(args, operation)) {
            pending = Buffer.concat([pending, chunk]);
            let end: number;
            while ((end = pending.indexOf(0)) >= 0) {
                const record = pending.subarray(0, end);
                pending = pending.subarray(end + 1);
                try {
                    yield new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record);
                } catch {
                    throw new SourceAccessError(
                        'unavailable',
                        'Git path is not representable as UTF-8; no complete listing.',
                    );
                }
            }
        }
        if (pending.length) throw new SourceAccessError('unavailable', 'Incomplete Git record.');
    }
    private async *entries(snapshot: Snapshot, operation: Operation) {
        for await (const record of this.records(['ls-tree', '-r', '-z', '--full-tree', snapshot.tree], operation)) {
            const tab = record.indexOf('\t');
            const [mode, , object] = record.slice(0, tab).split(' ');
            yield { ...snapshot, mode: mode!, object: object!, path: record.slice(tab + 1), kind: kind(mode!) };
        }
    }
    async list(
        request: { side: SourceSide; offset?: number },
        control: Control = {},
    ): Promise<Page<SourceEntry, { side: SourceSide; offset: number }> & { snapshot: Snapshot }> {
        const snapshot = this.snapshot(request.side);
        const offset = request.offset ?? 0;
        integer(offset, 'offset', 0);
        return this.operation(control, async (operation) => {
            const items: SourceEntry[] = [];
            let index = 0;
            for await (const entry of this.entries(snapshot, operation)) {
                if (index++ < offset) continue;
                if (items.length === this.limits.pageEntries)
                    return {
                        snapshot,
                        status: 'truncated',
                        items,
                        next: { side: snapshot.side, offset: offset + items.length },
                    };
                items.push(entry);
            }
            if (offset > index) throw new SourceAccessError('invalid_cursor', 'offset exceeds snapshot path count.');
            return { snapshot, status: 'complete', items, next: null };
        });
    }
    async changes(
        request: { offset?: number; detectRenames?: boolean } = {},
        control: Control = {},
    ): Promise<
        Page<SourceChange, { offset: number; detectRenames: boolean }> & {
            base: Snapshot;
            head: Snapshot;
            renameDetection: 'heuristic' | 'disabled';
        }
    > {
        const offset = request.offset ?? 0;
        integer(offset, 'offset', 0);
        const detectRenames = request.detectRenames ?? true;
        if (typeof detectRenames !== 'boolean')
            throw new SourceAccessError('invalid_input', 'detectRenames must be boolean.');
        const base = this.snapshot('base'),
            head = this.snapshot('head');
        return this.operation(control, async (operation) => {
            const items: SourceChange[] = [];
            const records = this.records(
                [
                    '-c',
                    'diff.renameLimit=0',
                    'diff-tree',
                    '--no-commit-id',
                    '-r',
                    '--raw',
                    '-z',
                    '--no-abbrev',
                    '-O/dev/null',
                    '--no-relative',
                    '--diff-algorithm=myers',
                    '--no-ext-diff',
                    '--no-textconv',
                    '--ignore-submodules=none',
                    detectRenames ? '--find-renames=50%' : '--no-renames',
                    base.tree,
                    head.tree,
                    '--',
                ],
                operation,
            );
            let header: string | undefined,
                firstPath: string | undefined,
                index = 0;
            for await (const record of records) {
                if (!header) {
                    header = record;
                    continue;
                }
                const [baseMode, headMode, baseObject, headObject, status] = header.slice(1).split(' ');
                if (status!.startsWith('R') && firstPath === undefined) {
                    firstPath = record;
                    continue;
                }
                if (index++ >= offset) {
                    if (items.length === this.limits.pageEntries)
                        return {
                            base,
                            head,
                            renameDetection: detectRenames ? 'heuristic' : 'disabled',
                            status: 'truncated',
                            items,
                            next: { offset: offset + items.length, detectRenames },
                        };
                    const source = (snapshot: Snapshot, mode: string, object: string, path: string) =>
                        mode === '000000' ? null : { ...snapshot, mode, object, path, kind: kind(mode) };
                    items.push({
                        kind: (
                            { A: 'addition', D: 'deletion', M: 'modification', R: 'rename', T: 'type_change' } as const
                        )[status![0] as 'A' | 'D' | 'M' | 'R' | 'T'],
                        base: source(base, baseMode!, baseObject!, firstPath ?? record),
                        head: source(head, headMode!, headObject!, record),
                        similarity: status!.startsWith('R') ? Number(status!.slice(1)) : null,
                    });
                }
                header = undefined;
                firstPath = undefined;
            }
            if (header || offset > index)
                throw new SourceAccessError('invalid_cursor', 'Invalid diff record or offset beyond change count.');
            return {
                base,
                head,
                renameDetection: detectRenames ? 'heuristic' : 'disabled',
                status: 'complete',
                items,
                next: null,
            };
        });
    }
    private async textReason(entry: SourceEntry, operation: Operation): Promise<string | null> {
        if (entry.kind === 'submodule') return 'submodule_commit_not_source';
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        try {
            for await (const chunk of this.git(['cat-file', 'blob', entry.object], operation)) {
                if (chunk.includes(0)) return 'binary_nul';
                decoder.decode(chunk, { stream: true });
            }
            decoder.decode();
        } catch (error) {
            if (error instanceof TypeError) return 'non_utf8';
            throw error;
        }
        return null;
    }
    private async *text(entry: SourceEntry, operation: Operation) {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        for await (const chunk of this.git(['cat-file', 'blob', entry.object], operation))
            yield decoder.decode(chunk, { stream: true });
        yield decoder.decode();
    }
    async read(request: ReadRequest, control: Control = {}): Promise<ReadResult> {
        const snapshot = this.snapshot(request.side);
        safePath(request.path);
        request = structuredClone(request);
        const start = request.start ?? { line: 1, column: 0 };
        integer(start.line, 'start.line');
        integer(start.column, 'start.column', 0);
        const endLine = request.endLine ?? Number.MAX_SAFE_INTEGER;
        integer(endLine, 'endLine');
        if (endLine < start.line) throw new SourceAccessError('invalid_input', 'endLine must be >= start.line.');
        return this.operation(control, async (operation) => {
            let entry: SourceEntry | null = null;
            for await (const candidate of this.entries(snapshot, operation))
                if (candidate.path === request.path) {
                    entry = candidate;
                    break;
                }
            if (!entry)
                return { snapshot, entry, status: 'unavailable', reason: 'missing_path', fragments: [], next: null };
            const reason = await this.textReason(entry, operation);
            if (reason) return { snapshot, entry, status: 'unsupported', reason, fragments: [], next: null };
            const fragments: ReadResult['fragments'] = [];
            let line = 1,
                column = 0,
                bytes = 0,
                lines = 0,
                found = false;
            let fragment: ReadResult['fragments'][number] | undefined;
            for await (const chunk of this.text(entry, operation)) {
                for (const char of chunk) {
                    operation.check();
                    if (line === start.line && column > start.column && !found)
                        throw new SourceAccessError(
                            'invalid_input',
                            'start.column splits a Unicode character or exceeds the line.',
                        );
                    if (line > endLine) return { snapshot, entry, status: 'complete', fragments, next: null };
                    if (line >= start.line && (line > start.line || column >= start.column)) {
                        found = true;
                        if (
                            (!fragment && lines === this.limits.readLines) ||
                            bytes + Buffer.byteLength(char) > this.limits.readBytes
                        )
                            return {
                                snapshot,
                                entry,
                                status: 'truncated',
                                fragments,
                                next: {
                                    side: snapshot.side,
                                    path: entry.path,
                                    start: { line, column },
                                    ...(request.endLine === undefined ? {} : { endLine }),
                                },
                            };
                        if (!fragment) {
                            fragment = { line, column, text: '' };
                            fragments.push(fragment);
                            lines++;
                        }
                        fragment.text += char;
                        bytes += Buffer.byteLength(char);
                    }
                    if (char === '\n') {
                        if (line === start.line && !found)
                            throw new SourceAccessError('invalid_input', 'start.column exceeds the line.');
                        line++;
                        column = 0;
                        fragment = undefined;
                    } else column += char.length;
                }
            }
            // Empty file and a position exactly at EOF are valid empty reads; trailing LF adds no source line.
            if (!found && !(line === start.line && column === start.column))
                throw new SourceAccessError('invalid_input', 'start is beyond the source.');
            return { snapshot, entry, status: 'complete', fragments, next: null };
        });
    }
    async search(
        request: { side: SourceSide; literal: string; path?: string; cursor?: SearchCursor },
        control: Control = {},
    ): Promise<SearchResult> {
        request = structuredClone(request);
        const snapshot = this.snapshot(request.side);
        if (typeof request.literal !== 'string' || !request.literal || /[\n\r\0]/u.test(request.literal))
            throw new SourceAccessError('invalid_input', 'literal must be nonempty single-line text without NUL.');
        if (request.path !== undefined) safePath(request.path);
        // Cursor binds the navigation position to this immutable snapshot, exact query and optional path.
        const scope = createHash('sha256')
            .update(
                JSON.stringify(
                    request.path === undefined
                        ? [snapshot, request.literal]
                        : [snapshot, request.literal, request.path],
                ),
            )
            .digest('hex');
        const cursor = request.cursor ?? { scope, entryOffset: 0, characterOffset: 0 };
        if (cursor.scope !== scope)
            throw new SourceAccessError('invalid_cursor', 'Cursor belongs to another snapshot, literal or path.');
        integer(cursor.entryOffset, 'cursor.entryOffset', 0);
        integer(cursor.characterOffset, 'cursor.characterOffset', 0);
        return this.operation(control, async (operation) => {
            const items: SourceMatch[] = [],
                skipped: SearchResult['skipped'] = [];
            let index = 0,
                scannedFiles = 0,
                foundPath = request.path === undefined;
            const result = (next: SearchCursor | null): SearchResult => ({
                snapshot,
                path: request.path ?? null,
                status: next ? 'truncated' : 'complete',
                items,
                skipped,
                scannedFiles,
                next,
                evidence: 'literal_navigation_only',
            });
            const prefix: number[] = new Array(request.literal.length).fill(0);
            for (let i = 1, j = 0; i < request.literal.length; i++) {
                while (j && request.literal[i] !== request.literal[j]) j = prefix[j - 1]!;
                if (request.literal[i] === request.literal[j]) j++;
                prefix[i] = j;
            }
            for await (const entry of this.entries(snapshot, operation)) {
                const entryOffset = index++;
                if (request.path !== undefined && entry.path !== request.path) continue;
                foundPath = true;
                if (entryOffset < cursor.entryOffset) continue;
                if (scannedFiles === this.limits.searchFiles) return result({ scope, entryOffset, characterOffset: 0 });
                scannedFiles++;
                const reason = await this.textReason(entry, operation);
                if (reason) {
                    skipped.push({ entry, reason });
                    continue;
                }
                let position = 0,
                    line = 1,
                    column = 0,
                    matched = 0;
                const minimum = entryOffset === cursor.entryOffset ? cursor.characterOffset : 0;
                for await (const chunk of this.text(entry, operation)) {
                    for (let i = 0; i < chunk.length; i++) {
                        operation.check();
                        const char = chunk[i]!;
                        while (matched && char !== request.literal[matched]) matched = prefix[matched - 1]!;
                        if (char === request.literal[matched]) matched++;
                        if (matched === request.literal.length) {
                            const start = position - matched + 1;
                            if (start >= minimum) {
                                items.push({ entry, line, column: column - matched + 1, endColumn: column + 1 });
                                if (items.length === this.limits.searchMatches)
                                    return result({ scope, entryOffset, characterOffset: start + 1 });
                            }
                            matched = prefix[matched - 1]!;
                        }
                        position++;
                        if (char === '\n') {
                            line++;
                            column = 0;
                        } else column++;
                    }
                }
                if (minimum > position)
                    throw new SourceAccessError('invalid_cursor', 'Search cursor exceeds file length.');
            }
            if (cursor.entryOffset > index)
                throw new SourceAccessError('invalid_cursor', 'Search cursor exceeds snapshot paths.');
            if (!foundPath)
                throw new SourceAccessError('unavailable', 'Search path is absent from the pinned snapshot.');
            return result(null);
        });
    }
}
