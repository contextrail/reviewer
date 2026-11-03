import { describe, expect, it } from 'vitest';
import { createPhaseRecord, validatePhaseRecord, type PhaseIdentity } from '../src/phases.js';
import { digest, structuredRequirements, type GitIdentity } from '../src/prepare.js';
import type { Publication } from '../src/contracts.js';
import { CitationError, EvidenceLedger } from '../src/evidence.js';

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
