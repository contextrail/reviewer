import { describe, expect, it } from 'vitest';
import { reportedUsage } from '../src/providers.js';
import { EvidenceLedger } from '../src/evidence.js';
import { DEFAULT_POLICY, decideExit, validateResult, type ReviewEntry } from '../src/results.js';
import type { Publication } from '../src/contracts.js';

const publication: Publication = {
    nodeId: 'context://engineering/rule',
    version: 2,
    type: 'context',
    subtype: 'standard',
    title: 'Rule',
    domainId: 'engineering',
    status: 'published',
    detailLevel: 'full',
    relationships: [],
    content: { kind: 'context', body: 'Enforce permission before disclosure.' },
};
function fixture() {
    const ledger = new EvidenceLedger();
    const p = ledger.publication(publication).find((e) => e.provenance.path === '/content/body')!;
    const s = ledger.add(
        'authorize(actor);\nreturn document;\n',
        { kind: 'source', side: 'head', commit: 'fixed', tree: 'fixed-tree', object: 'fixed-blob', path: 'route.ts' },
        [
            { line: 5, column: 0, text: 'authorize(actor);\n' },
            { line: 6, column: 0, text: 'return document;\n' },
        ],
    );
    const entries: ReviewEntry[] = [
        {
            nodeId: publication.nodeId,
            version: 2,
            subtype: 'standard',
            contentHash: 'hash',
            reasons: ['selected'],
            material: 'publications.json#a',
            assessmentId: 'a',
            result: { disposition: 'not_evaluated', adherence: null, confidence: null },
        },
    ];
    const input = {
        assessmentId: 'a',
        revisionOf: null,
        disposition: 'evaluated',
        adherence: 2,
        confidence: 3,
        confidenceReason: 'Direct inspected support, no runtime observation.',
        finding: 'none',
        explanation: 'Authorization precedes disclosure.',
        consequence: '',
        correction: '',
        limitations: ['Inspection only.'],
        citations: [
            { ref: p.ref, quote: p.text },
            { ref: s.ref, quote: 'return document;' },
        ],
    };
    return { ledger, p, s, entries, input };
}
describe('pinned citation validation and explicit revision', () => {
    it('computes offsets/locations and stable identities deterministically', () => {
        const { ledger, entries, input, s } = fixture();
        const accepted = validateResult(input, entries, ledger);
        expect(accepted.citations[1]).toMatchObject({
            start: 18,
            end: 34,
            location: { line: 6, column: 0 },
            provenance: { object: 'fixed-blob' },
        });
        expect(ledger.add(s.text, s.provenance).ref).toBe(s.ref);
        entries[0]!.result = accepted;
        expect(() => validateResult(input, entries, ledger)).toThrow('Duplicate/stale');
        expect(validateResult({ ...input, revisionOf: 1 }, entries, ledger).revision).toBe(2);
    });
    it('rejects absent/ambiguous quotes, unknown references and wrong pinned contexts', () => {
        const { ledger, entries, input, p } = fixture();
        for (const citation of [
            { ref: 'unknown', quote: 'permission' },
            { ref: p.ref, quote: 'invented' },
        ])
            expect(() => ledger.cite(citation)).toThrow();
        const repeated = ledger.add('same same', {});
        expect(() => ledger.cite({ ref: repeated.ref, quote: 'same' })).toThrow('ambiguous');
        const other = ledger
            .publication({ ...publication, version: 3 })
            .find((e) => e.provenance.path === '/content/body')!;
        expect(() =>
            validateResult(
                { ...input, citations: [{ ref: other.ref, quote: other.text }, input.citations[1]] },
                entries,
                ledger,
            ),
        ).toThrow('pinned publication');
        expect(() => validateResult({ ...input, assessmentId: 'unknown' }, entries, ledger)).toThrow(
            'Unknown assessmentId',
        );
        expect(() => validateResult({ ...input, citations: [input.citations[0]] }, entries, ledger)).toThrow(
            'concrete pinned source',
        );
    });
    it('preserves missing evidence and nonapplicability as null, never a zero', () => {
        const { ledger, entries, input } = fixture();
        expect(
            validateResult({ ...input, disposition: 'unresolved', adherence: null, confidence: null }, entries, ledger),
        ).toMatchObject({ disposition: 'unresolved', adherence: null, confidence: null });
        expect(() => validateResult({ ...input, disposition: 'unresolved', adherence: 0 }, entries, ledger)).toThrow(
            'null adherence',
        );
        expect(
            validateResult({ ...input, disposition: 'not_applicable', adherence: null }, entries, ledger),
        ).toMatchObject({ adherence: null, confidence: 3 });
        expect(() => validateResult({ ...input, adherence: 1 }, entries, ledger)).toThrow('specific unmet criterion');
    });
});
describe('settled policy is separate from judgment', () => {
    function entry(finding = 'none', adherence = 2, confidence: number | null = 3): ReviewEntry {
        const { ledger, entries, input } = fixture();
        entries[0]!.result = validateResult(
            { ...input, finding, adherence, consequence: 'Disclosure', correction: 'Restore guard' },
            entries,
            ledger,
        );
        entries[0]!.result.confidence = confidence as 1 | 2 | 3 | null;
        return entries[0]!;
    }
    it('applies thresholds, advisory and supported blocker precedence without changing results', () => {
        const blocker = entry('binding_violation', 0),
            advice = entry('guidance_departure', 1),
            satisfied = entry(),
            unexamined = fixture().entries[0]!;
        const before = JSON.stringify(blocker);
        expect(decideExit([blocker, unexamined], DEFAULT_POLICY).reviewExit).toBe(1);
        expect(decideExit([blocker, unexamined], { ...DEFAULT_POLICY, advisory: true }).reviewExit).toBe(2);
        expect(decideExit([blocker], { ...DEFAULT_POLICY, advisory: true }).reviewExit).toBe(0);
        expect(decideExit([blocker], { ...DEFAULT_POLICY, minAdherence: 0 }).reviewExit).toBe(1);
        expect(decideExit([advice], DEFAULT_POLICY).reviewExit).toBe(0);
        expect(decideExit([advice], { ...DEFAULT_POLICY, minAdherence: 2 }).reviewExit).toBe(1);
        expect(decideExit([advice], { ...DEFAULT_POLICY, minAdherence: 1 }).reviewExit).toBe(0);
        expect(decideExit([satisfied], { ...DEFAULT_POLICY, minConfidence: 3, minAdherence: 2 }).reviewExit).toBe(0);
        expect(decideExit([entry('binding_violation', 0, 1)], { ...DEFAULT_POLICY, minConfidence: 2 }).reviewExit).toBe(
            2,
        );
        expect(
            decideExit([entry('binding_violation', 0, null), blocker], { ...DEFAULT_POLICY, minConfidence: 3 })
                .reviewExit,
        ).toBe(1);
        expect(JSON.stringify(blocker)).toBe(before);
    });
    it('keeps execution failure separate from a blocker and applies confidence to nonapplicability', () => {
        const blocker = entry('behavioral_defect', 1);
        expect(decideExit([blocker], DEFAULT_POLICY, true, true)).toMatchObject({ exitCode: 2, reviewExit: 1 });
        const e = entry();
        e.result = {
            ...(e.result as Exclude<typeof e.result, { disposition: 'not_evaluated' }>),
            disposition: 'not_applicable',
            adherence: null,
            confidence: null,
        };
        expect(decideExit([e], DEFAULT_POLICY).exitCode).toBe(0);
        expect(decideExit([e], { ...DEFAULT_POLICY, minConfidence: 1 }).exitCode).toBe(2);
    });
});

it('never treats partial provider usage fields as reported zeroes', () => {
    expect(reportedUsage('openrouter', { prompt_tokens: 0, cost: 0 })).toMatchObject({
        inputTokens: 0,
        outputTokens: null,
        totalTokens: null,
        cost: 0,
    });
    expect(reportedUsage('openai', { input_tokens: 2, output_tokens: 3 })).toMatchObject({
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: null,
        cost: null,
    });
    expect(reportedUsage('openai', null)).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        raw: null,
        missing: 'provider_did_not_report',
    });
});
