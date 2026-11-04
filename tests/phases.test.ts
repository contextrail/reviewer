import { describe, expect, it } from 'vitest';
import { createPhaseRecord, validatePhaseRecord, type PhaseIdentity } from '../src/phases.js';
import { digest, structuredRequirements, type GitIdentity } from '../src/prepare.js';
import type { Publication } from '../src/contracts.js';
import { CitationError, EvidenceLedger, ModelIdentifiers, resolveCitationSelections } from '../src/evidence.js';

const artifact: GitIdentity = {
    kind: 'git_comparison',
    repository: '/not-accessed',
    repositoryEnvironment: { status: 'unavailable', reason: 'no_remote' },
    base: { suppliedRef: 'base', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    head: { suppliedRef: 'head', commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
    limitations: [],
};
function fixture() {
    const identity: PhaseIdentity = {
        runId: 'b6bb6820-7842-4f04-a44f-5180b05b1bd6',
        artifact,
        scopeIdentity: digest('fixed scope'),
        assessmentIds: ['assessment:a', 'assessment:b'],
        phase: 'assess',
        workUnitId: 'api',
        attempt: 1,
        inputRefs: [{ ref: 'phases/plan.json', hash: digest('plan') }],
    };
    const record = createPhaseRecord({
        ...identity,
        phase: 'assess',
        workUnitId: 'api',
        attempt: 1,
        startedAt: '2026-11-01T12:00:00.000Z',
        finishedAt: '2026-11-01T12:00:01.000Z',
        status: 'complete',
        inputRefs: identity.inputRefs!,
        evidenceRefs: ['evidence:publication', 'evidence:source'],
        limitations: [],
        stopReason: null,
        configuration: { provider: 'openrouter', model: 'chosen-model' },
        usageRefs: ['call:1'],
        output: { assessments: [{ id: 'assessment:a' }, { id: 'assessment:b' }] },
    });
    return { identity, record };
}
describe('content-free citation failures', () => {
    it.each(['citation_unknown', 'citation_absent', 'citation_ambiguous'] as const)(
        'retains the exact field path and safe reference identity for %s',
        (code) => {
            const ledger = new EvidenceLedger();
            const record = ledger.add('Repeated passage. Repeated passage. Unique exact evidence.', {
                kind: 'source',
                path: 'fixture.ts',
            });
            const ref = code === 'citation_unknown' ? 'PRIVATE_REJECTED_REFERENCE' : record.ref;
            const quote = code === 'citation_ambiguous' ? 'Repeated passage.' : 'PRIVATE_REJECTED_QUOTE';
            const path = ['assessments', 1, 'result', 'citations', 2];
            try {
                ledger.cite({ ref, quote }, path);
                throw new Error('Expected citation rejection.');
            } catch (error) {
                expect(error).toBeInstanceOf(CitationError);
                expect(error).toMatchObject({
                    code,
                    path,
                    ref: code === 'citation_unknown' ? null : record.ref,
                    refHash: digest(ref),
                });
                expect(`${JSON.stringify(error)} ${(error as Error).message}`).not.toMatch(
                    /PRIVATE_REJECTED_REFERENCE|PRIVATE_REJECTED_QUOTE/,
                );
            }
            expect(ledger.cite({ ref: record.ref, quote: 'Unique exact evidence.' }).quote).toBe(
                'Unique exact evidence.',
            );
        },
    );
});
describe('auditable phase contracts', () => {
    it('enumerates published structured requirements without manufacturing rules from prose', () => {
        const publication = {
            content: {
                body: 'An interpretation of this prose is not a deterministic extracted rule.',
                rules: [{ text: 'Authorize before disclosure.', exception: 'Permitted public resource.' }],
                checklist: ['Check tenant scope.'],
            },
        } as unknown as Publication;
        expect(structuredRequirements(publication)).toEqual([
            {
                path: '/content/rules/0',
                value: publication.content.rules && (publication.content.rules as unknown[])[0],
            },
            { path: '/content/checklist/0', value: 'Check tenant scope.' },
        ]);
        expect(structuredRequirements({ content: { body: 'Only prose.' } } as unknown as Publication)).toEqual([]);
    });
    it('accepts an intact handoff with exact fixed scope and upstream references', () => {
        const { identity, record } = fixture();
        expect(validatePhaseRecord(record, identity)).toEqual(record);
        expect(record.artifact).toEqual({
            base: { commit: artifact.base.commit, tree: artifact.base.tree },
            head: { commit: artifact.head.commit, tree: artifact.head.tree },
        });
    });
    it('rejects cross-run/revision/phase/attempt substitution and altered output or upstream references', () => {
        const { identity, record } = fixture();
        const corruptions = [
            { runId: 'da4fab87-9a88-4488-b334-5bdff1e2c879' },
            { scopeIdentity: digest('other scope') },
            { phase: 'verify' },
            { workUnitId: 'other' },
            { attempt: 2 },
            { artifact: { ...record.artifact, head: { ...record.artifact.head, tree: 'e'.repeat(40) } } },
            { output: { assessments: [] } },
            { inputRefs: [{ ref: 'phases/plan.json', hash: digest('different plan') }] },
            { assessmentIds: ['assessment:a'] },
            { assessmentIds: ['assessment:a', 'assessment:a'] },
            { assessmentIds: ['assessment:a', 'assessment:foreign'] },
            { contractVersion: 99 },
            { finishedAt: '2026-11-01T11:59:59.000Z' },
        ];
        for (const corruption of corruptions)
            expect(() => validatePhaseRecord({ ...record, ...corruption }, identity)).toThrow();
    });
    it('retains failed artifacts for inspection without allowing them to become a complete handoff', () => {
        const { identity, record } = fixture();
        for (const status of ['incomplete', 'failed', 'cancelled']) {
            const partial = { ...record, status };
            expect(() => validatePhaseRecord(partial, identity)).toThrow('invalid_phase_handoff');
            expect(validatePhaseRecord(partial, { ...identity, requireComplete: false }).status).toBe(status);
        }
    });
});

describe('PR intent context versioning', () => {
    it('retains the v1 reader and binds v2 title/body to the same fixed comparison', async () => {
        const { parsePrContext } = await import('../src/pr-context.js');
        const base = {
            version: 1,
            repository: 'acme/project',
            pr: 83,
            reviewer: 'skill://engineering/reviewer',
            capturedAt: '2026-11-01T12:00:00.000Z',
            comparison: { base: artifact.base.commit, head: artifact.head.commit },
            history: { status: 'available', runs: [], omitted: 0, assessment: null },
            discussion: { status: 'unavailable', items: [] },
            changesSincePrevious: {
                status: 'unavailable',
                base: null,
                head: artifact.head.commit,
                relation: '',
                files: [],
            },
            limitations: [],
        };
        expect(parsePrContext(base, artifact, base.reviewer).version).toBe(1);
        const next = {
            ...base,
            version: 2,
            intent: {
                title: 'Preserve tenant isolation',
                body: 'Assess changed resource handling.',
                source: 'github_pull_request',
            },
        };
        const parsed = parsePrContext(next, artifact, base.reviewer);
        expect(parsed.version).toBe(2);
        if (parsed.version === 2) expect(parsed.intent.title).toBe('Preserve tenant isolation');
        expect(() =>
            parsePrContext(
                { ...next, comparison: { ...next.comparison, head: 'e'.repeat(40) } },
                artifact,
                base.reviewer,
            ),
        ).toThrow('invalid_pr_context');
        expect(() =>
            parsePrContext({ ...next, intent: { ...next.intent, body: 'x'.repeat(20001) } }, artifact, base.reviewer),
        ).toThrow('invalid_pr_context');
    });
});

describe('model identifier boundary', () => {
    it('round-trips exact identifiers without rewriting evidence text or canonical records', () => {
        const ledger = new EvidenceLedger();
        const record = ledger.add('first line\nsecond line\n', { kind: 'source', path: 'src/example.ts' });
        const assessmentId = `assessment:${'a'.repeat(64)}`;
        const handles = new ModelIdentifiers([assessmentId], ledger.records);
        const canonical = {
            assessmentId,
            remaining: [assessmentId],
            citations: [{ ref: record.ref, startSegment: 2, endSegment: 2 }],
            quote: record.ref,
            explanation: assessmentId,
            segments: [{ index: 1, text: assessmentId }],
        };
        const presented = handles.toModel(canonical);
        expect(presented.assessmentId).toBe('context_1');
        expect(presented.remaining).toEqual(['context_1']);
        expect(presented.citations[0]!.ref).toBe('evidence_1');
        expect(presented.quote).toBe(record.ref);
        expect(presented.explanation).toBe(assessmentId);
        expect(presented.segments).toEqual(canonical.segments);
        expect(handles.fromModel(presented)).toEqual(canonical);
        const resolved = resolveCitationSelections(handles.fromModel({ citations: presented.citations }), ledger);
        expect(resolved).toMatchObject({ citations: [{ ref: record.ref, quote: 'second line\n' }] });
        expect(ledger.records[record.ref]).toEqual(record);
    });

    it('keeps repeated and paginated evidence distinct and never repairs unknown handles', () => {
        const ledger = new EvidenceLedger();
        const whole = ledger.add('one\ntwo', { kind: 'publication' });
        const handles = new ModelIdentifiers([], ledger.records);
        const page = ledger.add('two', { kind: 'publication', contentStart: 4 });
        const wholeView = handles.toModel({ ref: whole.ref });
        const pageView = handles.toModel({ ref: page.ref });
        expect(pageView.ref).not.toBe(wholeView.ref);
        expect(handles.toModel({ ref: whole.ref })).toEqual(wholeView);
        expect(handles.fromModel(pageView).ref).toBe(page.ref);
        expect(handles.fromModel({ assessmentId: 'context_999' }).assessmentId).toBe('context_999');
        const unknown = { ref: `evidence:${'f'.repeat(64)}` };
        expect(handles.toModel(unknown)).toEqual(unknown);
        expect(() =>
            resolveCitationSelections(
                handles.fromModel({ ref: 'evidence_999', startSegment: 1, endSegment: 1 }),
                ledger,
            ),
        ).toThrow('Unknown evidence ref');
    });

    it('projects canonical citations to compact locators without repeating source text', () => {
        const ledger = new EvidenceLedger();
        const text = 'original source line\n'.repeat(2_000);
        const evidence = ledger.add(text, {
            kind: 'source',
            path: 'src/example.ts',
            side: 'head',
            blob: 'a'.repeat(40),
            start: { line: 10, column: 0 },
        });
        const citation = ledger.cite({ ref: evidence.ref, quote: text });
        const canonical = {
            citations: [citation, citation],
            explanation: text,
            unknown: { ref: 'unknown', quote: 'keep' },
        };
        const before = JSON.stringify(canonical);
        const handles = new ModelIdentifiers([], ledger.records);
        const presented = handles.toModel(canonical);
        expect(presented.citations[0]).toEqual({ ref: 'evidence_1', provenance: citation.provenance });
        expect(presented.explanation).toBe(text);
        expect(presented.unknown).toEqual(canonical.unknown);
        expect(JSON.stringify(presented.citations).length).toBeLessThan(
            JSON.stringify(canonical.citations).length / 20,
        );
        expect(JSON.stringify(canonical)).toBe(before);
        expect(ledger.records[evidence.ref]!.text).toBe(text);
        expect(handles.fromModel({ ref: presented.citations[0]!.ref, startSegment: 1, endSegment: 1 }).ref).toBe(
            evidence.ref,
        );
        expect(
            handles.toModel({ evidence: { ref: evidence.ref, segments: [{ index: 1, text }] } }).evidence.segments[0]!
                .text,
        ).toBe(text);
    });
    it('omits result revision bookkeeping while preserving unrelated metadata and prose', () => {
        const handles = new ModelIdentifiers(['assessment:a'], {});
        const canonical = {
            result: {
                assessmentId: 'assessment:a',
                disposition: 'evaluated',
                adherence: 2,
                revision: 3,
                revisionOf: 2,
            },
            publication: { version: 4, revision: 8 },
            source: { revisionOf: 1, text: 'revisionOf: 2, revision: 3' },
            explanation: 'Assess revision 3 against publication version 4.',
        };
        const before = JSON.stringify(canonical);
        expect(handles.toModel(canonical)).toEqual({
            ...canonical,
            result: { assessmentId: 'context_1', disposition: 'evaluated', adherence: 2 },
        });
        expect(JSON.stringify(canonical)).toBe(before);
        expect(handles.fromModel(canonical)).toEqual(canonical);
    });
    it('exports stable audit mappings including dynamic evidence without exposing source text', () => {
        const ledger = new EvidenceLedger();
        const original = ledger.add('private original text', { kind: 'publication' });
        const handles = new ModelIdentifiers(['assessment:a'], ledger.records);
        const initial = handles.snapshot();
        expect(initial).toEqual({ context_1: 'assessment:a', evidence_1: original.ref });
        const dynamic = ledger.add('private dynamic source', { kind: 'source' });
        expect(handles.toModel({ ref: dynamic.ref }).ref).toBe('evidence_2');
        expect(handles.snapshot()).toEqual({ ...initial, evidence_2: dynamic.ref });
        initial.context_1 = 'modified outside adapter';
        expect(handles.snapshot().context_1).toBe('assessment:a');
        expect(JSON.stringify(handles.snapshot())).not.toContain('private');
    });
    it('seeds the same restored ledger consistently regardless of object insertion order', () => {
        const refs = [`evidence:${'b'.repeat(64)}`, `evidence:${'a'.repeat(64)}`];
        const first = new ModelIdentifiers(['assessment:a'], Object.fromEntries(refs.map((ref) => [ref, {}])));
        const restored = new ModelIdentifiers(
            ['assessment:a'],
            Object.fromEntries([...refs].reverse().map((ref) => [ref, {}])),
        );
        expect(first.toModel({ allowedRefs: refs })).toEqual(restored.toModel({ allowedRefs: refs }));
    });
});
