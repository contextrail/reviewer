import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Publication } from '../src/contracts.js';
import { EvidenceLedger } from '../src/evidence.js';
import { prepareEvidencePack, readPackPublication, writeEvidencePack } from '../src/pack.js';
import { digest, type PreparedState } from '../src/prepare.js';

function fixture(body = 'Keep the original contract.\r\nCheck the calling boundary.\n') {
    const publication = (nodeId: string, subtype: 'standard' | 'guidance'): Publication => ({
        nodeId,
        title: nodeId === 'context://contracts' ? 'Contracts' : 'Supporting guidance',
        domainId: 'engineering',
        type: 'context',
        subtype,
        status: 'published',
        detailLevel: 'full',
        version: 3,
        relationships: nodeId === 'context://contracts' ? [{ type: 'requires', targetId: 'context://support' }] : [],
        content: { kind: 'context', body, rules: [{ id: 'rule-1', requirement: 'Preserve allowed alternatives.' }] },
    });
    const publications = {
        primary: publication('context://contracts', 'standard'),
        dependency: publication('context://support', 'guidance'),
    };
    const state: PreparedState = {
        schemaVersion: 1,
        runId: 'pack-fixture',
        createdAt: '2026-11-02T00:00:00Z',
        preparationStatus: 'prepared',
        reviewStatus: 'not_started',
        requestedReviewerId: 'skill://review',
        reviewer: null,
        scopeIdentity: 'sha256:' + 'e'.repeat(64),
        expectedContextCount: 2,
        artifact: {
            kind: 'git_comparison',
            repository: '/fixture',
            repositoryEnvironment: { status: 'unavailable', reason: 'no_remote' },
            base: { commit: 'a'.repeat(40), tree: 'c'.repeat(40), suppliedRef: 'base' },
            head: { commit: 'b'.repeat(40), tree: 'd'.repeat(40), suppliedRef: 'head' },
            limitations: [],
        },
        entries: Object.entries(publications).map(([assessmentId, p]) => ({
            assessmentId,
            nodeId: p.nodeId,
            version: p.version,
            subtype: p.subtype as 'standard' | 'guidance',
            contentHash: digest(p.content),
            reasons: assessmentId === 'primary' ? ['selected context'] : ['required by context://contracts'],
            material: `publications.json#${assessmentId}`,
            result: { disposition: 'not_evaluated', adherence: null, confidence: null },
        })),
        gaps: [],
        limitations: ['Read-only pinned source; no runtime execution.'],
        changes: undefined,
    };
    const ledger = new EvidenceLedger();
    const pack = prepareEvidencePack({ state, publications, ledger });
    return { state, publications, ledger, pack };
}

describe('inspectable governed evidence pack', () => {
    it('indexes the entire pinned scope and prerequisite relationships without duplicating source excerpts', () => {
        const { state, publications, ledger, pack } = fixture();
        expect(pack.index.criteria.map((entry) => entry.assessmentId)).toEqual(['primary', 'dependency']);
        expect(pack.index.criteria[0]).toMatchObject({
            nodeId: 'context://contracts',
            version: 3,
            contentHash: digest(publications.primary.content),
            relationships: [{ type: 'requires', targetId: 'context://support' }],
            available: true,
        });
        expect(pack.index.criteria[1]!.reasons).toEqual(['required by context://contracts']);
        expect(pack.index.assets).toEqual({
            diff: 'diff.patch',
            preparation: 'preparation.md',
            publications: 'publications.json',
        });
        expect(pack.index.changedFiles).toBeNull();
        expect(pack.markdown).toContain('context://contracts @ 3');
        expect(pack.markdown).toContain('context://support @ 3');
        expect(pack.markdown).toContain('Keep the original contract.');
        expect(pack.markdown).toContain('not an assessment or proof of complete coverage');
        expect(pack.index.criteria[0]!.sections.map((entry) => entry.path)).toContain('/content/rules/0/requirement');
        const repeated = prepareEvidencePack({ state, publications, ledger });
        expect(repeated.index).toEqual(pack.index);
        expect(repeated.markdown).toBe(pack.markdown);
    });

    it('reads all original sections with reusable numbered ledger evidence and no host-file access', () => {
        const { pack, ledger, publications } = fixture();
        const result = readPackPublication(pack, ledger, { assessmentId: 'primary' });
        expect(result.status).toBe('complete');
        expect(result.next).toBeNull();
        expect(result.sections).toHaveLength(pack.index.criteria[0]!.sections.length);
        const body = result.evidence.find((entry) => entry.provenance.path === '/content/body')!;
        expect(body.ref).toBe(pack.index.criteria[0]!.sections.find((entry) => entry.path === '/content/body')!.ref);
        expect(body.provenance).toMatchObject({
            kind: 'publication',
            nodeId: 'context://contracts',
            version: 3,
            contentHash: digest(publications.primary.content),
        });
        expect(ledger.select({ ref: body.ref, startSegment: 1, endSegment: 2 }).quote).toBe(
            publications.primary.content.body,
        );
        expect(readPackPublication(pack, ledger, { assessmentId: '../../.env' })).toMatchObject({
            status: 'unavailable',
            reason: 'pack_publication_unknown',
            evidence: [],
        });
        expect(readPackPublication(pack, ledger, { assessmentId: 'primary', path: '/etc/passwd' })).toMatchObject({
            status: 'unavailable',
            reason: 'pack_read_invalid',
        });
    });

    it('retains incomplete inventory and exclusions without copying the prepared source diff', () => {
        const { state, publications, ledger } = fixture();
        const base = { side: 'base' as const, commit: state.artifact.base.commit, tree: state.artifact.base.tree };
        const head = { side: 'head' as const, commit: state.artifact.head.commit, tree: state.artifact.head.tree };
        const change = {
            offset: 0,
            kind: 'addition' as const,
            base: null,
            head: { ...head, path: 'src/changed.ts', object: 'f'.repeat(40), mode: '100644', kind: 'file' as const },
            similarity: null,
        };
        state.changes = {
            base,
            head,
            status: 'truncated',
            items: [change],
            next: { offset: 1, detectRenames: true },
            renameDetection: 'heuristic',
            excludedPaths: ['.env'],
            reason: 'Inventory capture was bounded.',
        };
        state.diff = {
            base,
            head,
            status: 'complete',
            next: null,
            renameDetection: 'heuristic',
            items: [
                { change, status: 'complete', patch: 'source text lives only in diff.patch', hash: digest('patch') },
            ],
        };
        const pack = prepareEvidencePack({ state, publications, ledger });
        expect(pack.index.changedFiles).toEqual(state.changes);
        expect(JSON.stringify(pack.index)).not.toContain('source text lives only in diff.patch');
        expect(pack.markdown).not.toContain('source text lives only in diff.patch');
        state.changes.items[0]!.head!.path = 'mutated-after-pinning.ts';
        expect(pack.index.changedFiles!.items[0]!.head!.path).toBe('src/changed.ts');
    });

    it('continues across publication sections without skipping bodies or exceeding the segment cap', () => {
        const { pack, ledger } = fixture();
        const expected = pack.index.criteria[0]!.sections.map((section) => ledger.records[section.ref]!.text).join('');
        let request = { assessmentId: 'primary' };
        let actual = '';
        for (let i = 0; i < 100; i++) {
            const page = readPackPublication(pack, ledger, request, { maxBytes: 16, maxSegments: 1 });
            expect(readPackPublication(pack, ledger, request, { maxBytes: 16, maxSegments: 1 })).toEqual(page);
            expect(page.evidence.flatMap((record) => record.segments)).toHaveLength(1);
            actual += page.evidence.map((record) => ledger.records[record.ref]!.text).join('');
            if (!page.next) break;
            request = page.next;
        }
        expect(actual).toBe(expected);
    });

    it('pages long UTF-8 fields and preserves original provenance, exact text and stable continuations', () => {
        const text = '😀'.repeat(20) + '\r\n' + '界'.repeat(20) + '\nlast';
        const { pack, ledger } = fixture(text);
        const section = pack.index.criteria[0]!.sections.find((entry) => entry.path === '/content/body')!.index;
        let request = { assessmentId: 'primary', section, offset: 0 };
        let reconstructed = '';
        for (let page = 0; page < 100; page++) {
            const result = readPackPublication(pack, ledger, request, { maxBytes: 24, maxSegments: 2 });
            expect(result.status).not.toBe('unavailable');
            expect(result.evidence.reduce((sum, record) => sum + record.segments.length, 0)).toBeLessThanOrEqual(2);
            expect(
                result.evidence.reduce((sum, record) => sum + Buffer.byteLength(ledger.records[record.ref]!.text), 0),
            ).toBeLessThanOrEqual(24);
            for (const record of result.evidence) {
                expect(record.provenance.kind).toBe('publication');
                if (record.provenance.path !== '/content/body') continue;
                const selected = ledger.select({
                    ref: record.ref,
                    startSegment: 1,
                    endSegment: record.segments.length,
                });
                reconstructed += selected.quote;
                expect(selected.quote).not.toContain('\uFFFD');
                const location = result.sections.find((part) => part.path === '/content/body')!;
                expect(selected.quote).toBe(text.slice(location.offset, location.end));
                if (location.offset || location.end !== text.length)
                    expect(record.provenance).toMatchObject({
                        contentStart: location.offset,
                        contentEnd: location.end,
                        contentLength: text.length,
                    });
            }
            if (!result.next || result.next.section !== section) break;
            expect(result.next.offset).toBeGreaterThan(request.offset);
            request = result.next as typeof request;
        }
        expect(reconstructed).toBe(text);
        expect(readPackPublication(pack, ledger, { assessmentId: 'primary', section, offset: 1 })).toMatchObject({
            reason: 'pack_range_invalid',
        });
    });

    it('keeps missing publications explicit and refuses identity, version or content drift', () => {
        const { state, publications } = fixture();
        const missing = prepareEvidencePack({
            state,
            publications: { primary: publications.primary },
            ledger: new EvidenceLedger(),
        });
        expect(missing.index.criteria[1]).toMatchObject({ assessmentId: 'dependency', available: false });
        expect(readPackPublication(missing, new EvidenceLedger(), { assessmentId: 'dependency' })).toMatchObject({
            reason: 'pinned_publication_unavailable',
        });
        for (const replacement of [
            { ...publications.primary, nodeId: 'context://foreign' },
            { ...publications.primary, version: 4 },
            { ...publications.primary, content: { ...publications.primary.content, body: 'Changed after pinning.' } },
        ])
            expect(() =>
                prepareEvidencePack({
                    state,
                    publications: { ...publications, primary: replacement },
                    ledger: new EvidenceLedger(),
                }),
            ).toThrow('pack_publication_mismatch');
    });

    it('writes fixed inspectable artifacts with byte hashes and replaces file symlinks instead of following them', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'governed-pack-'));
        try {
            const outside = join(directory, 'untouched.txt');
            await writeFile(outside, 'leave this alone');
            await symlink(outside, join(directory, 'evidence.md'));
            const { pack } = fixture();
            const written = await writeEvidencePack(directory, pack);
            expect(written.indexHash).toBe(digest(pack.index));
            for (const [name, hash] of Object.entries(written.files)) {
                const bytes = await readFile(join(directory, name));
                expect(hash).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
                expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
            }
            expect(await readFile(outside, 'utf8')).toBe('leave this alone');
            expect(await readFile(join(directory, 'evidence.md'), 'utf8')).toBe(pack.markdown);
            expect(JSON.parse(await readFile(join(directory, 'evidence-index.json'), 'utf8'))).toEqual(pack.index);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
