import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Publication } from '../src/contracts.js';
import { EvidenceLedger } from '../src/evidence.js';
import {
    modelPackEvidence,
    modelDiffEvidence,
    repositoryInstructionsEvidence,
    modelSourceEvidence,
    prepareEvidencePack,
    readPackPublication,
    writeEvidencePack,
} from '../src/pack.js';
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
    it('shares complete original standards and structured requirements with independently usable citations', () => {
        const { pack, publications } = fixture();
        const ledger = new EvidenceLedger();
        const shared = modelPackEvidence(pack, ledger);
        expect(shared.status).toBe('complete');
        expect(shared.omitted).toEqual([]);
        expect(shared.unavailable).toEqual([]);
        expect(shared.evidence.map((record) => record.ref)).toEqual(
            pack.index.criteria.flatMap((criterion) => criterion.sections.map((section) => section.ref)),
        );
        const body = shared.evidence.find((record) => record.provenance.path === '/content/body')!;
        expect(ledger.select({ ref: body.ref, startSegment: 1, endSegment: body.segments.length }).quote).toBe(
            publications.primary.content.body,
        );
        expect(
            shared.evidence.some((record) =>
                record.segments.some((segment) => segment.text === 'Preserve allowed alternatives.'),
            ),
        ).toBe(true);
        expect(modelPackEvidence(pack, new EvidenceLedger())).toEqual(shared);
    });

    it('bounds serialized shared input and exposes exact continuations for oversized original sections', () => {
        const original = '😀\\"\n'.repeat(60000);
        const { pack, ledger } = fixture(original);
        const shared = modelPackEvidence(pack, ledger);
        expect(Buffer.byteLength(JSON.stringify(shared))).toBeLessThanOrEqual(512 * 1024);
        expect(shared.status).toBe('incomplete');
        expect(shared.omitted).toHaveLength(2);
        for (const omitted of shared.omitted) {
            expect(omitted.reason).toBe('model_evidence_budget');
            expect(ledger.records[omitted.ref]!.text).toBe(original);
            const page = readPackPublication(pack, ledger, omitted.next);
            expect(page.status).toBe('truncated');
            expect(page.sections[0]).toMatchObject({ index: omitted.next.section, offset: 0 });
        }
        expect(shared.evidence.some((record) => record.provenance.path === '/content/rules/0/requirement')).toBe(true);
    });

    it('reports unavailable pinned material explicitly in shared model input', () => {
        const { state, publications, ledger } = fixture();
        const pack = prepareEvidencePack({ state, publications: { primary: publications.primary }, ledger });
        expect(modelPackEvidence(pack, ledger)).toMatchObject({
            status: 'incomplete',
            omitted: [],
            unavailable: [{ assessmentId: 'dependency', reason: 'pinned_publication_unavailable' }],
        });
    });

    it('shares already-read source fragments with their original status and continuation', () => {
        const { ledger } = fixture();
        const snapshot = { side: 'head' as const, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
        const next = { side: 'head' as const, path: 'changed.ts', start: { line: 9, column: 0 } };
        const record = ledger.source({
            snapshot,
            entry: { ...snapshot, path: 'changed.ts', object: 'c'.repeat(40), mode: '100644', kind: 'file' },
            status: 'truncated',
            fragments: [{ line: 8, column: 0, text: 'original source' }],
            next,
        })!;
        const shared = modelSourceEvidence(ledger, [record.ref]);
        expect(shared.evidence.map((item) => item.ref)).toEqual([record.ref]);
        expect(shared.scope).toBe('read_fragments');
        expect(shared.status).toBe('incomplete');
        expect(shared.evidence[0]!.provenance).toMatchObject({ readStatus: 'truncated', next });
        expect(shared.evidence[0]!.segments[0]!.text).toBe('original source');
    });

    it('bounds shared source records without replacing or silently truncating their original text', () => {
        const ledger = new EvidenceLedger();
        const huge = ledger.add('x'.repeat(600000), {
            kind: 'source',
            side: 'head',
            path: 'large.ts',
            start: { line: 1, column: 0 },
        });
        const small = ledger.add('exact original', {
            kind: 'source',
            side: 'base',
            path: 'small.ts',
            start: { line: 2, column: 3 },
        });
        const result = modelSourceEvidence(ledger, [small.ref]);
        expect(result.evidence.map((record) => record.ref)).toEqual([small.ref]);
        expect(result.omitted).toEqual([
            {
                ref: huge.ref,
                reason: 'model_evidence_budget',
                next: { side: 'head', path: 'large.ts', start: { line: 1, column: 0 } },
            },
        ]);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
    });

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

describe('sealed model diff', () => {
    it('supplies the complete patch once, falls back explicitly on size, and rejects changed or missing sealed input', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'review-model-diff-'));
        const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
        const fallback = {
            status: 'truncated',
            next: { offset: 2, patchLineOffset: 56, detectRenames: true },
            items: [],
        } as unknown as PreparedState['diff'];
        try {
            expect(await modelDiffEvidence(dir, undefined, fallback)).toMatchObject({
                status: 'truncated',
                fullPatch: { reason: 'artifact_unavailable' },
            });
            await expect(modelDiffEvidence(dir, hash('missing'), fallback)).rejects.toThrow(
                'upstream_artifact_changed',
            );
            const patch = 'diff --git a/example.ts b/example.ts\n-old\n+new\n';
            await writeFile(join(dir, 'diff.patch'), patch);
            expect(await modelDiffEvidence(dir, hash(patch), fallback)).toEqual({
                status: 'complete',
                format: 'unified',
                patch,
                hash: hash(patch),
            });
            await expect(modelDiffEvidence(dir, hash('different'), fallback)).rejects.toThrow(
                'upstream_artifact_changed',
            );
            const oversized = '"'.repeat(70 * 1024);
            await writeFile(join(dir, 'diff.patch'), oversized);
            const omitted = await modelDiffEvidence(dir, hash(oversized), fallback);
            expect(omitted).toMatchObject({
                ...fallback,
                fullPatch: { reason: 'model_diff_budget', bytes: Buffer.byteLength(oversized) },
            });
            expect(omitted).not.toHaveProperty('patch');
            await rm(join(dir, 'diff.patch'));
            await writeFile(join(dir, 'other'), patch);
            await symlink(join(dir, 'other'), join(dir, 'diff.patch'));
            await expect(modelDiffEvidence(dir, hash(patch), fallback)).rejects.toThrow('upstream_artifact_changed');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('repository authority evidence', () => {
    it('keeps unavailable reads explicit and propagates cancellation', async () => {
        const ledger = new EvidenceLedger();
        const source = {
            read: async () => {
                throw new Error('private failure');
            },
        };
        expect(await repositoryInstructionsEvidence(source, ledger)).toEqual({
            status: 'unavailable',
            next: { side: 'head', path: 'AGENTS.md' },
            reason: 'repository_instructions_unavailable',
            evidence: null,
        });
        await expect(repositoryInstructionsEvidence(source, ledger, AbortSignal.abort())).rejects.toThrow();
    });
});
