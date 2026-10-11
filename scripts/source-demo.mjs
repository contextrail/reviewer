import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only fixture construction runs Git writes; inspected code is never executed. */
export function createSourceFixture(large = false) {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-c2-'));
    const git = (...args) =>
        execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                GIT_AUTHOR_DATE: '2026-09-30T12:00:00Z',
                GIT_COMMITTER_DATE: '2026-09-30T12:00:00Z',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
            },
        }).trim();
    const write = (path, text) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    };
    const supporting =
        'export function authorize(actor) {\n    if (!actor.allowed) throw new Error("denied");\n    return actor;\n}\n';
    const before = new Map([
        [
            'caller.ts',
            'import { authorize } from "./lib/policy.ts";\nexport const handle = actor => authorize(actor);\n',
        ],
        ['lib/policy.ts', supporting],
        ['deleted.ts', 'export const obsolete = true;\n'],
        ['old name.ts', 'export const renamed = "identical";\n'],
        ['-leading dash.txt', 'literal [a.*] data\r\n🚂\n'],
        ['odd\tline\nname.txt', 'unusual path\n'],
        ['binary.dat', Buffer.from([65, 0, 66])],
        ['invalid-utf8.dat', Buffer.from([0xff, 0xfe])],
        ['empty.txt', ''],
        ['bom.txt', '\uFEFFkeep BOM\n'],
        ['.gitattributes', '*.ts diff=hostile\n'],
        ['package.json', '{"scripts":{"test":"touch EXECUTED"}}\n'],
    ]);
    for (const [path, text] of before) write(path, text);
    symlinkSync('/private/tmp/reviewer-must-not-read', join(root, 'outside-link'));
    before.set('outside-link', '/private/tmp/reviewer-must-not-read');
    git('init', '-q');
    git('config', 'user.name', 'C2 fixture');
    git('config', 'user.email', 'c2@example.invalid');
    git('add', '--all');
    git('commit', '-qm', 'fixture base');
    const base = git('rev-parse', 'HEAD');
    git('update-index', '--add', '--cacheinfo', `160000,${base},vendor/module`);
    git('commit', '-qm', 'fixture submodule');
    const pinnedBase = git('rev-parse', 'HEAD');
    const after = new Map(before);
    const handler =
        'import { authorize } from "./lib/policy.ts";\nexport const handle = actor => authorize({ ...actor, request: true });\n';
    write('caller.ts', handler);
    after.set('caller.ts', handler);
    write('added.ts', 'export const added = true;\n');
    after.set('added.ts', 'export const added = true;\n');
    rmSync(join(root, 'deleted.ts'));
    after.delete('deleted.ts');
    renameSync(join(root, 'old name.ts'), join(root, 'new name.ts'));
    after.delete('old name.ts');
    after.set('new name.ts', before.get('old name.ts'));
    if (large) {
        for (let file = 0; file < 64; file++) {
            const text = Array.from({ length: 7 }, (_, line) => `file-${file} line-${line}: NEEDLE NEEDLE\n`).join('');
            const path = `generated/file-${String(file).padStart(3, '0')}.txt`;
            write(path, text);
            after.set(path, text);
        }
        const text = `${'x'.repeat(70_000)}NEEDLE🚂\r\n${Array.from({ length: 270 }, (_, line) => `range ${line}: NEEDLE\n`).join('')}last without LF`;
        write('generated/long.txt', text);
        after.set('generated/long.txt', text);
    }
    git('add', '--all');
    git('update-index', '--add', '--cacheinfo', `160000,${base},vendor/module`);
    git('commit', '-qm', 'fixture head');
    const head = git('rev-parse', 'HEAD');
    // Malicious customer configuration would write a marker if a helper were executed.
    const helper = join(root, 'hostile.sh');
    write('hostile.sh', '#!/bin/sh\ntouch "' + join(root, 'EXECUTED') + '"\n');
    git('config', 'diff.external', `sh ${helper}`);
    git('config', 'diff.hostile.command', `sh ${helper}`);
    git('config', 'diff.hostile.textconv', `sh ${helper}`);
    git('config', 'core.fsmonitor', `sh ${helper}`);
    return {
        root,
        git,
        write,
        base: pinnedBase,
        head,
        before,
        after,
        supporting,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

export async function demonstrateSource(api) {
    const fixture = createSourceFixture(true);
    try {
        const artifact = api.fixGitIdentity(fixture.root, fixture.base, fixture.head);
        const source = new api.FixedSnapshotSource(artifact, {
            pageEntries: 7,
            searchMatches: 53,
            searchFiles: 11,
            readLines: 17,
            readBytes: 4096,
            timeoutMs: 60_000,
        });
        const changes = [];
        let request = {};
        let diffPages = 0;
        do {
            const page = await source.changes(request);
            diffPages++;
            changes.push(...page.items);
            request = page.next;
        } while (request);
        const pathEntries = [];
        request = { side: 'head' };
        let listPages = 0;
        do {
            const page = await source.list(request);
            listPages++;
            pathEntries.push(...page.items);
            request = page.next;
        } while (request);
        assert.equal(new Set(pathEntries.map((entry) => entry.path)).size, pathEntries.length);
        assert.deepEqual(
            pathEntries.map((entry) => entry.path).sort(),
            [...fixture.after.keys(), 'vendor/module'].sort(),
        );
        const expectedChanged = [
            'caller.ts',
            'added.ts',
            'deleted.ts',
            'old name.ts',
            'new name.ts',
            ...[...fixture.after.keys()].filter((path) => path.startsWith('generated/')),
        ].sort();
        const actualChanged = new Set(
            changes.flatMap((change) => [change.base?.path, change.head?.path].filter(Boolean)),
        );
        assert.deepEqual([...actualChanged].sort(), expectedChanged);
        assert.equal(changes.filter((change) => change.kind === 'rename').length, 1);
        assert(!actualChanged.has('lib/policy.ts'));
        const discovery = await source.search({ side: 'head', literal: 'function authorize' });
        // This fixture places the supporting path after generated files: continue even empty match pages.
        let supportingMatch = discovery.items[0],
            continuation = discovery.next;
        while (!supportingMatch && continuation) {
            const page = await source.search({ side: 'head', literal: 'function authorize', cursor: continuation });
            supportingMatch = page.items[0];
            continuation = page.next;
        }
        assert.equal(supportingMatch.entry.path, 'lib/policy.ts');
        const supportingRead = await source.read({ side: 'head', path: supportingMatch.entry.path });
        assert.equal(supportingRead.fragments.map((fragment) => fragment.text).join(''), fixture.supporting);
        const matches = [];
        let cursor;
        let searchPages = 0;
        const skipped = new Map();
        do {
            const page = await source.search({ side: 'head', literal: 'NEEDLE', ...(cursor ? { cursor } : {}) });
            searchPages++;
            matches.push(...page.items);
            for (const item of page.skipped) skipped.set(item.entry.path, item.reason);
            cursor = page.next;
        } while (cursor);
        const expectedMatches = [];
        for (const [path, text] of fixture.after)
            if (typeof text === 'string') {
                text.split('\n').forEach((line, index) => {
                    for (let column = line.indexOf('NEEDLE'); column >= 0; column = line.indexOf('NEEDLE', column + 1))
                        expectedMatches.push(`${path}:${index + 1}:${column}`);
                });
            }
        const matchKeys = matches.map((match) => `${match.entry.path}:${match.line}:${match.column}`);
        assert.equal(new Set(matchKeys).size, matchKeys.length);
        assert.deepEqual(matchKeys.sort(), expectedMatches.sort());
        let readPages = 0;
        const fragments = [];
        request = { side: 'head', path: 'generated/long.txt' };
        do {
            const page = await source.read(request);
            readPages++;
            fragments.push(...page.fragments);
            assert(
                Buffer.byteLength(page.fragments.map((fragment) => fragment.text).join('')) <= source.limits.readBytes,
            );
            request = page.next;
        } while (request);
        let line = 1,
            column = 0;
        for (const fragment of fragments) {
            assert.equal(fragment.line, line);
            assert.equal(fragment.column, column);
            for (const char of fragment.text) {
                if (char === '\n') {
                    line++;
                    column = 0;
                } else column += char.length;
            }
        }
        assert.equal(fragments.map((fragment) => fragment.text).join(''), fixture.after.get('generated/long.txt'));
        // Move HEAD and dirty both index/worktree after capture, then use the same operations again.
        fixture.git('switch', '-qc', 'later');
        fixture.write('caller.ts', 'later committed caller\n');
        fixture.git('-c', 'core.fsmonitor=false', 'add', 'caller.ts');
        fixture.git('commit', '-qm', 'later branch');
        fixture.write('lib/policy.ts', 'staged changed policy\n');
        fixture.git('-c', 'core.fsmonitor=false', 'add', 'lib/policy.ts');
        fixture.write('lib/policy.ts', 'dirty changed policy\n');
        fixture.write('.gitattributes', '*.ts -diff\n');
        fixture.write('diff-order.txt', 'new name.ts\ncaller.ts\n');
        fixture.git('config', 'diff.orderFile', join(fixture.root, 'diff-order.txt'));
        fixture.git('config', 'diff.relative', 'true');
        assert.equal(
            (await source.read({ side: 'head', path: 'lib/policy.ts' })).fragments
                .map((fragment) => fragment.text)
                .join(''),
            fixture.supporting,
        );
        assert.equal(
            (await source.read({ side: 'base', path: 'caller.ts' })).fragments
                .map((fragment) => fragment.text)
                .join(''),
            fixture.before.get('caller.ts'),
        );
        const frozenChanges = [];
        request = {};
        do {
            const page = await source.changes(request);
            frozenChanges.push(...page.items);
            request = page.next;
        } while (request);
        assert.deepEqual(frozenChanges, changes);
        assert.throws(() => readFileSync(join(fixture.root, 'EXECUTED')));
        return {
            pinned: { base: artifact.base, head: artifact.head },
            limits: source.limits,
            changes: changes.length,
            changedPathIdentities: actualChanged.size,
            listedPaths: pathEntries.length,
            literalMatches: matches.length,
            diffPages,
            listPages,
            searchPages,
            readPages,
            longFileBytes: Buffer.byteLength(fixture.after.get('generated/long.txt')),
            reconciliation: 'exact paths, matches and contiguous source fragments; no missing or duplicated material',
            unchangedSupportingCode: { changeContainsPath: false, discovery: supportingMatch, read: supportingRead },
            skipped: Object.fromEntries(skipped),
            laterChangesIsolated: true,
            passiveHelperMarkerAbsent: true,
        };
    } finally {
        fixture.cleanup();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const api = await import(
        process.argv.includes('--installed') ? '@contextrail/code-review-agent' : '../dist/index.js'
    );
    process.stdout.write(JSON.stringify(await demonstrateSource(api), null, 2) + '\n');
}
