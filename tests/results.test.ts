import {
    deriveAssessmentCitations,
    validateReviewSubmission,
    reviewSelectionSchema,
    reconcileFindings,
    type ReviewFinding,
} from '../src/assessment.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    resolveVerificationAmendments,
    validateVerification,
    verificationSchema,
    verificationSelectionSchema,
} from '../src/verification.js';
import { reportedUsage } from '../src/providers.js';
import {
    CitationError,
    EvidenceLedger,
    citationSchema,
    selectionSchema,
    modelEvidence,
    resolveCitationSelections,
    MAX_SUBMISSION_QUOTE_BYTES,
} from '../src/evidence.js';
import { modelResultSchema, DEFAULT_POLICY, decideExit, validateResult, type ReviewEntry } from '../src/results.js';
import type { Publication } from '../src/contracts.js';
import { digest } from '../src/prepare.js';

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
    it('identifies the exact failed result citation without retaining rejected content', () => {
        const { ledger, entries, input, s } = fixture();
        const quote = 'REJECTED_QUOTE_MUST_NOT_ENTER_ERRORS';
        try {
            validateResult({ ...input, citations: [input.citations[0], { ref: s.ref, quote }] }, entries, ledger, [
                'assessments',
                0,
                'result',
            ]);
            expect.fail('invalid quotation accepted');
        } catch (error) {
            expect(error).toBeInstanceOf(CitationError);
            expect(error).toMatchObject({
                code: 'citation_absent',
                path: ['assessments', 0, 'result', 'citations', 1],
                ref: s.ref,
            });
            expect(JSON.stringify(error)).not.toContain(quote);
            expect(String(error)).not.toContain(quote);
        }
        const malicious = 'UNKNOWN_REF_WITH_PRIVATE_CONTENT';
        try {
            ledger.cite({ ref: malicious, quote }, ['citations', 0]);
            expect.fail('unknown reference accepted');
        } catch (error) {
            expect(error).toMatchObject({ code: 'citation_unknown', ref: null, path: ['citations', 0] });
            expect((error as CitationError).refHash).toMatch(/^sha256:[a-f0-9]{64}$/);
            expect(JSON.stringify(error)).not.toContain(malicious);
            expect(String(error)).not.toContain(malicious);
        }
        const repeated = ledger.add('same same', {});
        expect(() => ledger.cite({ ref: repeated.ref, quote: 'same' })).toThrow('ambiguous');
        expect(() => ledger.cite({ ref: s.ref, quote: 'authorize(actor); return document;' })).toThrow('Quote absent');
        expect(ledger.cite({ ref: s.ref, quote: 'authorize(actor);\nreturn document;' })).toMatchObject({ start: 0 });
    });
    it.each(['__proto__', 'constructor', 'toString'])(
        'rejects inherited evidence key %s with targeted feedback',
        (ref) => {
            const { ledger } = fixture();
            try {
                ledger.cite({ ref, quote: 'text' }, ['citations', 0]);
                expect.fail('inherited reference accepted');
            } catch (error) {
                expect(error).toBeInstanceOf(CitationError);
                expect(error).toMatchObject({ code: 'citation_unknown', ref: null, path: ['citations', 0] });
            }
        },
    );
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
    it.each([
        ['advisory', 0, 0],
        ['required', 1, 0],
        ['strict', 1, 1],
    ] as const)('applies %s without changing judgments', (enforcement, violationExit, gapExit) => {
        const violation = entry('binding_violation', 0);
        const defect = entry('behavioral_defect', 1);
        const advice = entry('guidance_departure', 1);
        const gap = entry();
        gap.result = {
            ...gap.result,
            disposition: 'unresolved',
            adherence: null,
            confidence: null,
        } as typeof gap.result;
        const inputs = [violation, defect, advice, gap];
        const before = JSON.stringify(inputs);
        const policy = { enforcement };
        for (const issue of [violation, defect]) {
            expect(decideExit([issue], policy)).toMatchObject({
                exitCode: violationExit,
                reviewExit: violationExit,
                complete: true,
            });
            expect(decideExit([issue, gap], policy)).toMatchObject({ exitCode: violationExit, complete: false });
        }
        expect(decideExit([gap], policy)).toMatchObject({ exitCode: gapExit, reviewExit: gapExit, complete: false });
        expect(decideExit([entry(), advice], policy)).toMatchObject({ exitCode: 0, complete: true });
        expect(decideExit([gap], policy).reasons[0]?.blocking).toBe(enforcement === 'strict');
        expect(JSON.stringify(inputs)).toBe(before);
    });
    it.each(['advisory', 'required', 'strict'] as const)(
        'keeps missing execution coverage an error in %s',
        (enforcement) => {
            const policy = { enforcement };
            expect(decideExit([], policy).exitCode).toBe(2);
            expect(decideExit(fixture().entries, policy).exitCode).toBe(2);
            expect(decideExit([entry()], policy, true, true)).toMatchObject({ exitCode: 2, complete: false });
            const issue = entry('behavioral_defect', 1);
            expect(decideExit([issue], policy, false, true)).toMatchObject({
                exitCode: 2,
                reviewExit: enforcement === 'advisory' ? 0 : 1,
            });
        },
    );
    it('defaults to advisory and retains verified findings on unresolved criteria', () => {
        expect(DEFAULT_POLICY).toEqual({ enforcement: 'advisory' });
        const gap = entry();
        gap.result = {
            ...gap.result,
            disposition: 'unresolved',
            adherence: null,
            confidence: null,
        } as typeof gap.result;
        const finding = { verified: true, classification: 'behavioral_defect', assessmentIds: [gap.assessmentId] };
        expect(decideExit([gap], { enforcement: 'required' }, false, false, [finding])).toMatchObject({
            exitCode: 1,
            complete: false,
        });
        expect(
            decideExit([gap], { enforcement: 'required' }, false, false, [{ ...finding, verified: false }]).exitCode,
        ).toBe(0);
        expect(decideExit([gap], DEFAULT_POLICY, false, false, [finding]).exitCode).toBe(0);
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

describe('exact issue reconciliation across governed contexts', () => {
    const finding = (): ReviewFinding => ({
        findingId: 'finding:a',
        assessmentIds: ['assessment:a'],
        checkIds: ['check:a'],
        classification: 'binding_violation',
        locationRefs: [
            {
                ref: 'evidence:source',
                quote: 'return document;',
                start: 0,
                end: 16,
                location: { line: 1, column: 0 },
                provenance: {
                    kind: 'source',
                    side: 'head',
                    commit: 'a'.repeat(40),
                    path: 'route.ts',
                    object: 'b'.repeat(40),
                },
            },
        ],
        explanation: 'Return bypasses authorization.',
        consequence: 'Unauthorized disclosure.',
        correction: 'Authorize before return.',
        limitations: ['Source inspection.'],
        verified: true,
    });
    it('merges exact independently verified issue accounts while preserving every criterion and source finding identity', () => {
        const first = finding(),
            second = { ...finding(), findingId: 'finding:b', assessmentIds: ['assessment:b'], checkIds: ['check:b'] };
        const result = reconcileFindings([second, first]);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            assessmentIds: ['assessment:a', 'assessment:b'],
            checkIds: ['check:a', 'check:b'],
            sourceFindingIds: ['finding:a', 'finding:b'],
            verified: true,
        });
        expect(first.assessmentIds).toEqual(['assessment:a']);
    });
    it('does not erase issues with different consequences, corrections, classifications or verification status', () => {
        const first = finding();
        expect(reconcileFindings([first, { ...finding(), consequence: 'Different supported impact.' }])).toHaveLength(
            2,
        );
        expect(reconcileFindings([first, { ...finding(), correction: 'Different correction.' }])).toHaveLength(2);
        expect(reconcileFindings([first, { ...finding(), classification: 'guidance_departure' }])).toHaveLength(2);
        expect(reconcileFindings([first, { ...finding(), verified: false }])).toHaveLength(2);
    });
});

describe('code-owned quotations from evidence-relative segments', () => {
    it.each([
        ['', []],
        ['last', ['last']],
        ['a\n', ['a\n']],
        ['\n\n', ['\n', '\n']],
        ['α\r\n\r\n🌱\nlast', ['α\r\n', '\r\n', '🌱\n', 'last']],
        ['a\rb', ['a\r', 'b']],
    ] as Array<[string, string[]]>)('preserves exact line text and EOF boundaries for %j', (text, expected) => {
        const ledger = new EvidenceLedger(),
            record = ledger.add(text, { kind: 'source', path: 'fixture.ts' }),
            view = modelEvidence(record);
        expect(Object.keys(view)).toEqual(['ref', 'provenance', 'segments']);
        expect(view.segments).toEqual(expected.map((text, index) => ({ index: index + 1, text })));
        expect(view.segments.map((s) => s.text).join('')).toBe(text);
        expect(view.segments.every((s) => s.text.length > 0)).toBe(true);
    });
    it('selects repeated line occurrences unambiguously by position without fuzzy matching', () => {
        const ledger = new EvidenceLedger(),
            record = ledger.add('same\nsame\n', { kind: 'source' });
        const selected = ledger.select({ ref: record.ref, startSegment: 2, endSegment: 2 });
        expect(selected).toMatchObject({ ref: record.ref, quote: 'same\n', start: 5, end: 10 });
        expect(
            ledger.cite({ ref: selected.ref, quote: selected.quote, start: selected.start, end: selected.end }),
        ).toEqual(selected);
        expect(() => ledger.cite({ ref: record.ref, quote: 'same\n' })).toThrow(CitationError);
        expect(() => ledger.cite({ ref: record.ref, quote: 'SAME\n', start: 5, end: 10 })).toThrow(CitationError);
    });
    it('maps partial source fragments using evidence-relative indices and exact Unicode/CRLF offsets', () => {
        const ledger = new EvidenceLedger(),
            snapshot = { side: 'head' as const, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
        const record = ledger.source({
            snapshot,
            entry: { ...snapshot, path: 'partial.ts', object: 'c'.repeat(40), mode: '100644', kind: 'file' },
            status: 'truncated',
            fragments: [
                { line: 41, column: 7, text: 'α\r\n' },
                { line: 42, column: 0, text: '🌱\r\n' },
                { line: 43, column: 0, text: 'last' },
            ],
            next: { side: 'head', path: 'partial.ts', start: { line: 43, column: 4 } },
        })!;
        const selected = ledger.select({ ref: record.ref, startSegment: 2, endSegment: 3 });
        expect(selected).toMatchObject({ quote: '🌱\r\nlast', start: 3, end: 11, location: { line: 42, column: 0 } });
        expect(ledger.select({ ref: record.ref, startSegment: 1, endSegment: 1 }).location).toEqual({
            line: 41,
            column: 7,
        });
        expect(record.text.slice(selected.start, selected.end)).toBe(selected.quote);
    });
    it.each([
        [0, 1, 'startSegment'],
        [-1, 1, 'startSegment'],
        [1.5, 2, 'startSegment'],
        [Infinity, 2, 'startSegment'],
        [3, 3, 'startSegment'],
        [1, 0, 'endSegment'],
        [2, 1, 'endSegment'],
        [1, 3, 'endSegment'],
    ] as Array<[number, number, string]>)(
        'rejects invalid selection %s..%s at the specific field',
        (startSegment, endSegment, field) => {
            const ledger = new EvidenceLedger(),
                record = ledger.add('PRIVATE_LINE_ONE\nPRIVATE_LINE_TWO', { kind: 'source' });
            let failure: unknown;
            try {
                ledger.select({ ref: record.ref, startSegment, endSegment }, ['assessments', 0, 'citations', 1]);
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(CitationError);
            expect(failure).toMatchObject({
                code: 'citation_range_invalid',
                path: ['assessments', 0, 'citations', 1, field],
                ref: record.ref,
            });
            expect(JSON.stringify(failure)).not.toContain('PRIVATE_LINE');
        },
    );
    it('rejects unknown prototype-key refs and empty-record ranges with content-free typed errors', () => {
        const ledger = new EvidenceLedger();
        for (const ref of ['constructor', '__proto__', 'PRIVATE_UNKNOWN_REF']) {
            let failure: unknown;
            try {
                ledger.select({ ref, startSegment: 1, endSegment: 1 }, ['citations', 0]);
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(CitationError);
            expect(failure).toMatchObject({ code: 'citation_unknown', path: ['citations', 0, 'ref'], ref: null });
            expect(String(failure)).not.toContain(ref);
        }
        const empty = ledger.add('', { kind: 'source' });
        expect(() => ledger.select({ ref: empty.ref, startSegment: 1, endSegment: 1 })).toThrow(CitationError);
        expect(modelEvidence(empty).segments).toEqual([]);
    });
    it('requires paired canonical offsets and validates exact offset bounds', () => {
        const ledger = new EvidenceLedger(),
            record = ledger.add('abcd', { kind: 'source' }),
            base = { ref: record.ref, quote: 'bc' };
        expect(citationSchema.safeParse(base).success).toBe(true);
        expect(citationSchema.safeParse({ ...base, start: 1 }).success).toBe(false);
        expect(citationSchema.safeParse({ ...base, end: 3 }).success).toBe(false);
        expect(ledger.cite({ ...base, start: 1, end: 3 })).toMatchObject({ quote: 'bc', start: 1, end: 3 });
        for (const offsets of [
            { start: -1, end: 3 },
            { start: 1, end: 1 },
            { start: 1, end: 5 },
            { start: 0, end: 2 },
        ])
            expect(() => ledger.cite({ ...base, ...offsets })).toThrow(CitationError);
    });
    it('resolves nested strict selections to canonical inputs without exposing a quote escape hatch', () => {
        const ledger = new EvidenceLedger(),
            record = ledger.add('first\nsecond', { kind: 'source' });
        const selector = { ref: record.ref, startSegment: 2, endSegment: 2 },
            input = {
                assessments: [{ result: { citations: [selector] }, checks: [{ sourceRefs: [selector] }] }],
                flag: false,
                note: 'unchanged',
            };
        const resolved = resolveCitationSelections(input, ledger) as typeof input & {
            assessments: Array<{ result: { citations: unknown[] }; checks: Array<{ sourceRefs: unknown[] }> }>;
        };
        const expected = { ref: record.ref, quote: 'second', start: 6, end: 12 };
        expect(resolved.assessments[0]!.result.citations[0]).toEqual(expected);
        expect(resolved.assessments[0]!.checks[0]!.sourceRefs[0]).toEqual(expected);
        expect(resolved.flag).toBe(false);
        expect(input.assessments[0]!.result.citations[0]).toBe(selector);
        expect(selectionSchema.safeParse({ ...selector, quote: 'first' }).success).toBe(false);
        expect(() => resolveCitationSelections({ citations: [{ ref: record.ref, quote: 'first' }] }, ledger)).toThrow(
            CitationError,
        );
    });
    it('applies the remaining extraction allowance before accepting a selected range', () => {
        const ledger = new EvidenceLedger();
        const record = ledger.add('🌱', { kind: 'source' });
        const selection = { ref: record.ref, startSegment: 1, endSegment: 1 };
        expect(ledger.select(selection, ['passage'], 4).quote).toBe('🌱');
        for (const remaining of [3, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
            expect(() => ledger.select(selection, ['passage'], remaining)).toThrowError(
                expect.objectContaining({ code: 'citation_range_invalid', path: ['passage', 'endSegment'] }),
            );
    });
    it('bounds UTF-8 quotation expansion per selection and across one submission', () => {
        const ledger = new EvidenceLedger(),
            allowed = ledger.add('🌱'.repeat(16384), { kind: 'source' }),
            tooLarge = ledger.add('🌱'.repeat(16385), { kind: 'source' });
        expect(Buffer.byteLength(ledger.select({ ref: allowed.ref, startSegment: 1, endSegment: 1 }).quote)).toBe(
            65536,
        );
        expect(() => ledger.select({ ref: tooLarge.ref, startSegment: 1, endSegment: 1 })).toThrow(CitationError);
        const selection = { ref: allowed.ref, startSegment: 1, endSegment: 1 };
        expect(MAX_SUBMISSION_QUOTE_BYTES).toBe(1024 * 1024);
        expect(
            (resolveCitationSelections({ citations: Array(16).fill(selection) }, ledger) as { citations: unknown[] })
                .citations,
        ).toHaveLength(16);
        let failure: unknown;
        try {
            resolveCitationSelections({ citations: Array(17).fill(selection) }, ledger);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(CitationError);
        expect(failure).toMatchObject({ code: 'citation_range_invalid', path: ['citations', 16, 'endSegment'] });
    });
});

function modelJudgment() {
    const { assessmentId, disposition, confidence, confidenceReason, explanation, limitations } = fixture().input;
    return { assessmentId, disposition, confidence, confidenceReason, explanation, limitations };
}
function modelAssessmentFixture() {
    const { input, entries, ledger } = fixture();
    const result = modelJudgment();
    const check = {
        passage: input.citations[0],
        interpretation: 'Apply governing requirement.',
        disposition: 'evaluated',
        explanation: 'Source inspected.',
        sourceRefs: [input.citations[1]],
        contraryEvidence: '',
        missingEvidence: '',
    };
    const finding = {
        classification: 'binding_violation',
        checkIndices: [0],
        locationRefs: [input.citations[1]],
        explanation: 'Observed unmet obligation.',
        consequence: 'Disclosure.',
        correction: 'Restore check.',
        limitations: [],
        proposedReplacement: null,
    };
    return { entries, ledger, result, check, finding };
}
describe('minimal model judgment contract', () => {
    it('asks only for applicability, confidence and an explanation, never aggregate finding claims or protocol metadata', () => {
        expect(Object.keys(modelJudgment()).sort()).toEqual([
            'assessmentId',
            'confidence',
            'confidenceReason',
            'disposition',
            'explanation',
            'limitations',
        ]);
        expect(z.toJSONSchema(modelResultSchema()).type).toBe('object');
        expect(z.toJSONSchema(verificationSelectionSchema.shape.entries.element).type).toBe('object');
        for (const disposition of ['evaluated', 'not_applicable', 'unresolved'])
            for (const confidence of [null, 1, 2, 3])
                expect(modelResultSchema().safeParse({ ...modelJudgment(), disposition, confidence }).success).toBe(
                    true,
                );
        for (const key of ['adherence', 'finding', 'consequence', 'correction', 'revisionOf', 'citations'])
            expect(modelResultSchema().safeParse({ ...modelJudgment(), [key]: null }).success).toBe(false);
    });
    it('keeps evaluated confidence validation at the canonical boundary', () => {
        const { result, check, entries, ledger } = modelAssessmentFixture();
        const model = { ...result, confidence: null };
        expect(modelResultSchema().safeParse(model).success).toBe(true);
        const derived = deriveAssessmentCitations(
            { assessments: [{ result: model, checks: [check], findings: [] }] },
            entries,
        );
        expect(() => validateResult(derived.result, entries, ledger)).toThrow();
    });
    it('emits strict all-required model objects', () => {
        const inspect = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            const schema = value as Record<string, unknown>;
            if (schema.type === 'object') {
                expect(schema.additionalProperties).toBe(false);
                expect([...(schema.required as string[])].sort()).toEqual(
                    Object.keys(schema.properties as object).sort(),
                );
            }
            for (const nested of Object.values(schema)) inspect(nested);
        };
        for (const schema of [modelResultSchema(), reviewSelectionSchema, verificationSelectionSchema])
            inspect(z.toJSONSchema(schema));
    });
});
describe('deterministic assessment aggregate', () => {
    it('produces a clean evaluated outcome from no finding accounts without forcing a dummy finding', () => {
        const { result, check, entries } = modelAssessmentFixture();
        const derived = deriveAssessmentCitations(
            {
                assessments: [
                    {
                        result: { ...result, explanation: 'There is no supported finding.' },
                        checks: [check],
                        findings: [],
                    },
                ],
            },
            entries,
        );
        expect(derived.result).toMatchObject({
            adherence: 2,
            finding: 'none',
            consequence: '',
            correction: '',
            revisionOf: null,
        });
    });
    it('derives ranked classification and distinct consequences/remedies only from actual accounts', () => {
        const { result, check, finding, entries } = modelAssessmentFixture();
        const findings = [
            {
                ...finding,
                classification: 'guidance_departure',
                consequence: 'Maintainability.',
                correction: 'Simplify.',
            },
            { ...finding, classification: 'behavioral_defect' },
            finding,
        ];
        const derived = deriveAssessmentCitations({ assessments: [{ result, checks: [check], findings }] }, entries);
        expect(derived.result).toMatchObject({
            adherence: 0,
            finding: 'binding_violation',
            consequence: 'Maintainability.\nDisclosure.',
            correction: 'Simplify.\nRestore check.',
        });
    });
    it('does not silently discard findings on a nonapplicable judgment', () => {
        const { result, check, finding, entries, ledger } = modelAssessmentFixture();
        const derived = deriveAssessmentCitations(
            {
                assessments: [
                    {
                        result: { ...result, disposition: 'not_applicable', confidence: null },
                        checks: [check],
                        findings: [finding],
                    },
                ],
            },
            entries,
        );
        expect(derived.result).toMatchObject({ adherence: null, finding: 'binding_violation' });
        expect(derived.findings).toHaveLength(1);
        expect(() => validateResult(derived.result, entries, ledger)).toThrow('Unresolved/nonapplicable judgments');
    });
    it('retains known findings separately from an unresolved criterion and normalizes only aggregate confidence', () => {
        const { result, check, finding, entries, ledger } = modelAssessmentFixture();
        entries[0]!.contentHash = digest(publication.content);
        const derived = deriveAssessmentCitations(
            {
                assessments: [
                    {
                        result: {
                            ...result,
                            disposition: 'unresolved',
                            confidence: 3,
                            confidenceReason: 'Certain that the external value is unavailable.',
                        },
                        checks: [
                            check,
                            {
                                ...check,
                                interpretation: 'Verify the external package selection.',
                                disposition: 'unresolved',
                                missingEvidence: 'Inspect external version value.',
                            },
                        ],
                        findings: [finding],
                    },
                ],
            },
            entries,
        );
        expect(derived.result).toMatchObject({
            adherence: null,
            confidence: null,
            finding: 'none',
            confidenceReason: 'Certain that the external value is unavailable.',
            correction: 'Restore check.\nInspect external version value.',
        });
        expect(derived.findings).toHaveLength(1);
        expect(validateReviewSubmission({ assessments: [derived] }, entries, ledger).findings).toHaveLength(1);
    });
    it('preserves an unresolved check’s explicit missing evidence as the required follow-up', () => {
        const { result, check, entries } = modelAssessmentFixture();
        const derived = deriveAssessmentCitations(
            {
                assessments: [
                    {
                        result: { ...result, disposition: 'unresolved', confidence: null },
                        checks: [
                            {
                                ...check,
                                disposition: 'unresolved',
                                missingEvidence: 'Inspect the actual downstream consumer.',
                            },
                        ],
                        findings: [],
                    },
                ],
            },
            entries,
        );
        expect(derived.result).toMatchObject({
            adherence: null,
            finding: 'none',
            correction: 'Inspect the actual downstream consumer.',
        });
    });
    it('derives the exact current revision for initial and resumed judgments', () => {
        const { result, check, entries } = modelAssessmentFixture();
        const input = { assessments: [{ result, checks: [check], findings: [] }] };
        expect(deriveAssessmentCitations(input, entries).result.revisionOf).toBe(null);
        const revisedEntries = entries.map((entry) => ({ ...entry, result: { ...entry.result, revision: 7 } }));
        expect(deriveAssessmentCitations(input, revisedEntries).result.revisionOf).toBe(7);
        expect(() => deriveAssessmentCitations(input, [])).toThrow('foreign_assessment_id');
    });
});
describe('model verification acceptance contract', () => {
    const verdict = {
        assessmentId: 'context_1',
        disposition: 'accept',
        reason: 'Evidence supports this assessment.',
        citations: [],
        missingChecks: [],
        amendment: null,
        findings: [{ findingId: 'finding_1', decision: 'accept', explanation: null }],
    };
    it('accepts supported findings without a competing correction or unresolved checks', () => {
        expect(verificationSelectionSchema.safeParse({ entries: [verdict] }).success).toBe(true);
    });
    it.each(['amendment', 'missingChecks', 'rejectedFinding'])(
        'rejects acceptance with %s at the canonical boundary',
        (field) => {
            const { result, check, finding, entries, ledger } = modelAssessmentFixture();
            entries[0]!.contentHash = digest(publication.content);
            const assessment = deriveAssessmentCitations(
                { assessments: [{ result, checks: [check], findings: [finding] }] },
                entries,
            );
            const proposal = validateReviewSubmission({ assessments: [assessment] }, entries, ledger);
            const candidate = {
                ...verdict,
                assessmentId: result.assessmentId,
                resolution: null,
                citations: [check.passage, ...check.sourceRefs],
                findings: [
                    {
                        explanation: 'Supported.',
                        suggestionAccepted: false,
                        findingId: proposal.findings[0]!.findingId,
                        accepted: field !== 'rejectedFinding',
                    },
                ],
                missingChecks: field === 'missingChecks' ? ['Inspect another surface.'] : [],
                amendment: field === 'amendment' ? assessment : null,
            };
            expect(() => validateVerification({ entries: [candidate] }, [proposal], ledger, entries)).toThrow(
                field === 'amendment' ? 'verification_amendment_inconsistent' : 'verification_acceptance_inconsistent',
            );
        },
    );
    it('rejects the obsolete model resolution field while canonical records still accept it', () => {
        const input = { entries: [{ ...verdict, findings: [], disposition: 'revise', resolution: fixture().input }] };
        expect(verificationSchema.safeParse(input).success).toBe(true);
        expect(verificationSelectionSchema.safeParse(input).success).toBe(false);
    });
    it('retains nonacceptance with unresolved checks and rejected findings', () => {
        expect(
            verificationSelectionSchema.safeParse({
                entries: [
                    {
                        ...verdict,
                        disposition: 'unresolved',
                        missingChecks: ['Inspect another surface.'],
                        findings: [{ ...verdict.findings[0], decision: 'reject', explanation: 'Unsupported.' }],
                    },
                ],
            }).success,
        ).toBe(true);
    });
});

describe('compact verification expansion', () => {
    function setup() {
        const { result, check, finding, entries, ledger } = modelAssessmentFixture();
        entries[0]!.contentHash = digest(publication.content);
        const assessment = deriveAssessmentCitations(
            { assessments: [{ result, checks: [check], findings: [finding] }] },
            entries,
        );
        const proposal = validateReviewSubmission({ assessments: [assessment] }, entries, ledger);
        const verdict = {
            assessmentId: proposal.result.assessmentId,
            disposition: 'accept',
            reason: null,
            citations: [],
            missingChecks: [],
            amendment: null,
            findings: [{ findingId: proposal.findings[0]!.findingId, decision: 'accept', explanation: null }],
        };
        const expand = (value: unknown) => resolveVerificationAmendments({ entries: [value] }, entries, [proposal]);
        const validate = (value: unknown) => validateVerification(expand(value), [proposal], ledger, entries);
        return { verdict, proposal, expand, validate, ledger, entries };
    }
    it('references known evidence while requiring explicit finding decisions', () => {
        const { verdict, proposal, validate } = setup();
        const [accepted] = validate(verdict);
        expect(accepted!.citations).toEqual(proposal.result.citations);
        expect(accepted!.findings[0]).toMatchObject({ accepted: true, suggestionAccepted: false });
        expect(() => validate({ ...verdict, findings: [] })).toThrow();
        expect(() => validate({ ...verdict, assessmentId: 'foreign' })).toThrow('foreign_assessment_id');
    });
    it('never accepts an omitted assessment or an unproposed patch', () => {
        const { verdict, proposal, validate, ledger, entries } = setup();
        expect(() => validateVerification({ entries: [] }, [proposal], ledger, entries)).toThrow();
        expect(() =>
            validate({ ...verdict, findings: [{ ...verdict.findings[0], decision: 'accept_with_suggestion' }] }),
        ).toThrow('unproposed_suggestion_acceptance');
    });
    it('requires correction evidence and rejection explanations', () => {
        const { verdict, expand } = setup();
        expect(() => expand({ ...verdict, disposition: 'unresolved' })).toThrow(
            'verification_correction_evidence_required',
        );
        expect(() => expand({ ...verdict, findings: [{ ...verdict.findings[0], decision: 'reject' }] })).toThrow(
            'verification_rejection_explanation_required',
        );
    });
    it('keeps supported findings alongside separately unresolved checks', () => {
        const { verdict, proposal, validate } = setup();
        const [unresolved] = validate({
            ...verdict,
            disposition: 'unresolved',
            reason: 'Boundary still uninspected.',
            citations: proposal.result.citations.map(({ ref, quote, start, end }) => ({ ref, quote, start, end })),
            missingChecks: ['Inspect the consequential boundary.'],
        });
        expect(unresolved!.disposition).toBe('unresolved');
        expect(unresolved!.findings[0]!.accepted).toBe(true);
    });
});
