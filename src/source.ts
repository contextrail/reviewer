import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MAX_PREPARATION_BYTES, passiveGitEnvironment, sensitiveGitPath } from './git.js';
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
    offset: number;
    kind: 'addition' | 'modification' | 'deletion' | 'rename' | 'type_change';
    base: SourceEntry | null;
    head: SourceEntry | null;
    similarity: number | null;
};
export type ChangeInventory = {
    base: Snapshot;
    head: Snapshot;
    status: 'complete' | 'truncated';
    items: SourceChange[];
    next: { offset: number; detectRenames: boolean } | null;
    renameDetection: 'heuristic' | 'disabled';
    excludedPaths: string[];
    reason?: string;
};
type PreparedDiff = {
    change: SourceChange;
    status: 'complete' | 'truncated' | 'unsupported';
    reason?: string;
    patch: string;
    hash: string;
};
export type DiffRequest = { offset?: number; patchLineOffset?: number; detectRenames?: boolean };
export type DiffPage = Page<PreparedDiff, { offset: number; patchLineOffset: number; detectRenames: boolean }> & {
    base: Snapshot;
    head: Snapshot;
    renameDetection: 'heuristic' | 'disabled';
};
const sensitiveSourcePath = sensitiveGitPath;
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

type DiffBudget = { bytes: number; lines: number };
type PatchProgress = { line: number; skip: number };
function acceptPatchLine(
    item: PreparedDiff,
    line: string,
    progress: PatchProgress,
    budget: DiffBudget,
    limits: SourceLimits,
): boolean {
    if (progress.line++ < progress.skip) return true;
    const size = Buffer.byteLength(line);
    if (budget.bytes + size > limits.readBytes || budget.lines >= limits.readLines) {
        if (!item.patch && budget.bytes === 0 && size > limits.readBytes) {
            item.status = 'unsupported';
            item.reason = 'diff_line_exceeds_response_limit';
        } else item.status = 'truncated';
        progress.line--;
        return false;
    }
    budget.bytes += size;
    budget.lines++;
    item.patch += line;
    return true;
}

/** One bounded read window; positions use UTF-16 columns while budgets count UTF-8 bytes. */
class ReadWindow {
    readonly fragments: ReadResult['fragments'] = [];
    line = 1;
    column = 0;
    private bytes = 0;
    private found = false;
    private fragment: ReadResult['fragments'][number] | undefined;
    constructor(
        private start: SourcePosition,
        private endLine: number,
        private limits: SourceLimits,
    ) {}
    accept(char: string): 'complete' | 'truncated' | null {
        if (this.line === this.start.line && this.column > this.start.column && !this.found)
            throw new SourceAccessError(
                'invalid_input',
                'start.column splits a Unicode character or exceeds the line.',
            );
        if (this.line > this.endLine) return 'complete';
        const inWindow =
            this.line > this.start.line || (this.line === this.start.line && this.column >= this.start.column);
        if (inWindow && !this.append(char)) return 'truncated';
        this.advance(char);
        return null;
    }
    private append(char: string): boolean {
        this.found = true;
        const bytes = Buffer.byteLength(char);
        if (
            (!this.fragment && this.fragments.length === this.limits.readLines) ||
            this.bytes + bytes > this.limits.readBytes
        )
            return false;
        if (!this.fragment) {
            this.fragment = { line: this.line, column: this.column, text: '' };
            this.fragments.push(this.fragment);
        }
        this.fragment.text += char;
        this.bytes += bytes;
        return true;
    }
    private advance(char: string) {
        if (char !== '\n') {
            this.column += char.length;
            return;
        }
        if (this.line === this.start.line && !this.found)
            throw new SourceAccessError('invalid_input', 'start.column exceeds the line.');
        this.line++;
        this.column = 0;
        this.fragment = undefined;
    }
    finish() {
        // Empty file and a position exactly at EOF are valid empty reads; trailing LF adds no source line.
        if (!this.found && !(this.line === this.start.line && this.column === this.start.column))
            throw new SourceAccessError('invalid_input', 'start is beyond the source.');
    }
}

/** UTF-16 prefix lengths preserve overlapping literal matches across blob chunks. */
function literalPrefix(literal: string): number[] {
    const prefix: number[] = new Array(literal.length).fill(0);
    for (let i = 1, j = 0; i < literal.length; i++) {
        while (j && literal[i] !== literal[j]) j = prefix[j - 1]!;
        if (literal[i] === literal[j]) j++;
        prefix[i] = j;
    }
    return prefix;
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
                        offset: index - 1,
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
    /** Complete permitted file inventory without reading patches; metadata is navigation, not assessment. */
    async changeInventory(control: Control = {}): Promise<ChangeInventory> {
        const inventory: ChangeInventory = {
            base: this.snapshot('base'),
            head: this.snapshot('head'),
            status: 'truncated',
            items: [],
            next: { offset: 0, detectRenames: true },
            renameDetection: 'heuristic',
            excludedPaths: [],
        };
        // Reserve bounded room for the final reason/cursor and serialization separators.
        let bytes = Buffer.byteLength(JSON.stringify(inventory)) + 512;
        try {
            return await this.operation(control, async (operation) => {
                while (inventory.next) {
                    const cursor = inventory.next;
                    const page = await this.changes(cursor, { signal: operation.signal });
                    for (const item of page.items) {
                        const paths = [item.base?.path, item.head?.path].filter((path): path is string => !!path);
                        const excluded = paths.some(sensitiveGitPath);
                        const size = Buffer.byteLength(JSON.stringify(excluded ? paths : item)) + 2;
                        if (bytes + size > MAX_PREPARATION_BYTES) {
                            inventory.reason = 'inventory_output_limit';
                            inventory.next = { offset: item.offset, detectRenames: true };
                            return inventory;
                        }
                        bytes += size;
                        if (excluded) inventory.excludedPaths.push(...paths);
                        else inventory.items.push(item);
                        inventory.next = { offset: item.offset + 1, detectRenames: true };
                    }
                    if (page.next && page.next.offset <= cursor.offset)
                        throw new SourceAccessError('invalid_cursor', 'Change inventory did not advance.');
                    inventory.next = page.next;
                }
                inventory.excludedPaths = [...new Set(inventory.excludedPaths)];
                inventory.status = 'complete';
                return inventory;
            });
        } catch (error) {
            inventory.status = 'truncated';
            inventory.next ??= { offset: 0, detectRenames: true };
            inventory.reason = error instanceof SourceAccessError ? error.code : 'unavailable';
            return inventory;
        }
    }
    /** Ordinary unified patch fragments; continuations retain the fixed comparison. */
    async diff(request: DiffRequest = {}, control: Control = {}): Promise<DiffPage> {
        const offset = request.offset ?? 0;
        const patchLineOffset = request.patchLineOffset ?? 0;
        integer(offset, 'offset', 0);
        integer(patchLineOffset, 'patchLineOffset', 0);
        const changes = await this.changes({ offset, detectRenames: request.detectRenames }, control);
        return this.operation(control, async (operation) => {
            const items: PreparedDiff[] = [];
            const budget: DiffBudget = { bytes: 0, lines: 0 };
            const result = (next: DiffPage['next']): DiffPage => ({
                base: changes.base,
                head: changes.head,
                renameDetection: changes.renameDetection,
                status: next ? 'truncated' : 'complete',
                items,
                next,
            });
            for (const [index, change] of changes.items.entries()) {
                const fileOffset = offset + index;
                const skipLines = index === 0 ? patchLineOffset : 0;
                const paths = [...new Set([change.base?.path, change.head?.path].filter((p): p is string => !!p))];
                const item: PreparedDiff = { change, status: 'complete', patch: '', hash: '' };
                const finishItem = () => {
                    item.hash = `sha256:${createHash('sha256').update(item.patch).digest('hex')}`;
                    items.push(item);
                };
                const reason = await this.diffReason(change, paths, operation);
                if (reason) {
                    item.status = 'unsupported';
                    item.reason = reason;
                    finishItem();
                    continue;
                }
                const args = [
                    '--literal-pathspecs',
                    'diff',
                    '--no-ext-diff',
                    '--no-textconv',
                    '--no-color',
                    '--src-prefix=a/',
                    '--dst-prefix=b/',
                    '--unified=3',
                    '--diff-algorithm=myers',
                    '--no-relative',
                    changes.renameDetection === 'heuristic' ? '--find-renames=50%' : '--no-renames',
                    changes.base.tree,
                    changes.head.tree,
                    '--',
                    ...paths,
                ];
                const patchLine = await this.appendPatch(item, args, skipLines, budget, operation);
                finishItem();
                if (item.status === 'truncated')
                    return result({
                        offset: fileOffset,
                        patchLineOffset: patchLine,
                        detectRenames: request.detectRenames ?? true,
                    });
                if (budget.lines >= this.limits.readLines || budget.bytes >= this.limits.readBytes)
                    return result({
                        offset: fileOffset + 1,
                        patchLineOffset: 0,
                        detectRenames: request.detectRenames ?? true,
                    });
            }
            return result(changes.next ? { ...changes.next, patchLineOffset: 0 } : null);
        });
    }
    private async diffReason(change: SourceChange, paths: string[], operation: Operation): Promise<string | null> {
        if (paths.some(sensitiveSourcePath)) return 'sensitive_path_excluded';
        for (const entry of [change.base, change.head]) {
            if (!entry) continue;
            const reason = await this.textReason(entry, operation);
            if (reason) return reason;
        }
        return null;
    }
    private async appendPatch(
        item: PreparedDiff,
        args: string[],
        skip: number,
        budget: DiffBudget,
        operation: Operation,
    ): Promise<number> {
        const progress: PatchProgress = { line: 0, skip };
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let pending = '';
        for await (const chunk of this.git(args, operation)) {
            pending += decoder.decode(chunk, { stream: true });
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end + 1);
                pending = pending.slice(end + 1);
                if (!acceptPatchLine(item, line, progress, budget, this.limits)) return progress.line;
            }
            if (Buffer.byteLength(pending) > this.limits.readBytes) {
                item.status = 'unsupported';
                item.reason = 'diff_line_exceeds_response_limit';
                return progress.line;
            }
        }
        pending += decoder.decode();
        if (pending) acceptPatchLine(item, pending, progress, budget, this.limits);
        if (progress.line < skip)
            throw new SourceAccessError('invalid_cursor', 'Patch continuation exceeds file diff.');
        return progress.line;
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
            const window = new ReadWindow(start, endLine, this.limits);
            const result = (status: 'complete' | 'truncated'): ReadResult => ({
                snapshot,
                entry,
                status,
                fragments: window.fragments,
                next:
                    status === 'complete'
                        ? null
                        : {
                              side: snapshot.side,
                              path: entry.path,
                              start: { line: window.line, column: window.column },
                              ...(request.endLine === undefined ? {} : { endLine }),
                          },
            });
            for await (const chunk of this.text(entry, operation)) {
                for (const char of chunk) {
                    operation.check();
                    const status = window.accept(char);
                    if (status) return result(status);
                }
            }
            window.finish();
            return result('complete');
        });
    }
    private async *literalMatches(
        entry: SourceEntry,
        literal: string,
        prefix: number[],
        minimum: number,
        operation: Operation,
    ): AsyncGenerator<{ match: SourceMatch; offset: number }> {
        let position = 0,
            line = 1,
            column = 0,
            matched = 0;
        for await (const chunk of this.text(entry, operation)) {
            for (let i = 0; i < chunk.length; i++) {
                operation.check();
                const char = chunk[i]!;
                while (matched && char !== literal[matched]) matched = prefix[matched - 1]!;
                if (char === literal[matched]) matched++;
                if (matched === literal.length) {
                    const offset = position - matched + 1;
                    if (offset >= minimum)
                        yield { match: { entry, line, column: column - matched + 1, endColumn: column + 1 }, offset };
                    matched = prefix[matched - 1]!;
                }
                position++;
                if (char === '\n') {
                    line++;
                    column = 0;
                } else column++;
            }
        }
        if (minimum > position) throw new SourceAccessError('invalid_cursor', 'Search cursor exceeds file length.');
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
            const prefix = literalPrefix(request.literal);
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
                const minimum = entryOffset === cursor.entryOffset ? cursor.characterOffset : 0;
                for await (const { match, offset } of this.literalMatches(
                    entry,
                    request.literal,
                    prefix,
                    minimum,
                    operation,
                )) {
                    items.push(match);
                    if (items.length === this.limits.searchMatches)
                        return result({ scope, entryOffset, characterOffset: offset + 1 });
                }
            }
            if (cursor.entryOffset > index)
                throw new SourceAccessError('invalid_cursor', 'Search cursor exceeds snapshot paths.');
            if (!foundPath)
                throw new SourceAccessError('unavailable', 'Search path is absent from the pinned snapshot.');
            return result(null);
        });
    }
}
