import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPhaseRecord } from '../src/phases.js';
import { digest, type GitIdentity } from '../src/prepare.js';
import {
    assessmentCoverage,
    groupDeveloperFindings,
    renderReviewComment,
    renderActionSummary,
    summarizeUsage,
    runRecord,
    withHistory,
    readHistory,
} from '../src/presentation.js';
const state = {
    runId: 'run-1',
    reviewStatus: 'incomplete',
    reviewer: { nodeId: 'skill://engineering/review', version: 2 },
    artifact: { head: { commit: 'b'.repeat(40) } },
    entries: [
        {
            assessmentId: 'criterion',
            nodeId: 'context://engineering/contract',
            version: 1,
            result: {
                disposition: 'evaluated',
                finding: 'binding_violation',
                explanation: 'Response contradicts the promised contract.',
                correction: 'Restore the accepted field.',
            },
        },
        {
            assessmentId: 'gap',
            nodeId: 'context://engineering/evidence',
            version: 1,
            result: { disposition: 'unresolved', finding: 'none', explanation: 'Runtime evidence is unavailable.' },
        },
    ],
    findings: [
        {
            findingId: 'verified-example',
            assessmentIds: ['criterion'],
            checkIds: ['check'],
            classification: 'binding_violation',
            explanation: 'Response contradicts the promised contract.',
            consequence: 'The caller contract breaks.',
            correction: 'Restore the accepted field.',
            locationRefs: [],
            verified: true,
        },
    ],
    execution: {
        stopReason: 'finished',
        calls: 2,
        elapsedMs: 1000,
        providerUsage: [
            { call: 1, usage: { cost: 0.01, prompt_tokens: 100 } },
            { call: 2, usage: { cost: 0.02, input_tokens: 200 } },
        ],
    },
};
describe('governed presentation', () => {
    it('leads with governed findings and coverage while details stay collapsed', () => {
        const body = renderReviewComment(state);
        expect(body.indexOf('Governed findings')).toBeLessThan(body.indexOf('Assessment coverage'));
        expect(body.indexOf('Assessment coverage')).toBeLessThan(body.indexOf('<summary>Run details'));
        expect(body.indexOf('$0.030000')).toBeGreaterThan(body.indexOf('<summary>Run details'));
        expect(body).toContain('Assessment incomplete');
    });
    it('escapes model markdown, mentions and HTML without suppressing explanation', () => {
        const input = structuredClone(state);
        input.entries[0]!.result.explanation = '@here <script> ![image](https://bad)\n# forged';
        const body = renderReviewComment(input);
        expect(body).toContain('&#64;here');
        expect(body).not.toContain('<script>');
        expect(body).not.toContain('![image]');
        expect(body).not.toContain('\n# forged');
    });
    it('sums mixed-provider wire usage once and keeps missing cost unknown', () => {
        expect(summarizeUsage(state).input.value).toBe(300);
        expect(summarizeUsage(state).cost.value).toBe(0.03);
        const s = structuredClone(state);
        delete (s.execution.providerUsage[1]!.usage as { cost?: number }).cost;
        expect(summarizeUsage(s).cost).toMatchObject({ value: 0.01, complete: false });
    });
    it('keeps operational phase information in the action summary', () => {
        const body = renderActionSummary({
            ...state,
            phases: [{ phase: 'verify', status: 'failed', effectiveConfiguration: { model: 'verify-model' } }],
        });
        expect(body).toContain('verify');
        expect(body).toContain('verify-model');
        expect(body).toContain('Health / performance');
    });
    it('records effective phase overrides rather than the unused shared default', () => {
        const config = {
            repository: 'acme/project',
            pr: 3,
            reviewer: 'skill://engineering/review',
            githubRun: '100',
            githubAttempt: 1,
            provider: 'openrouter',
            model: 'unused-default',
            effort: 'medium',
        };
        const same = { provider: 'openai', model: 'phase-model', effort: 'high' };
        const phased = {
            ...state,
            execution: { ...state.execution, phaseModels: { assess: same, verify: same } },
        };
        const record = runRecord(config, { base: 'a'.repeat(40), head: 'b'.repeat(40) }, phased, 1, null, false);
        expect(record.row).toMatchObject({ provider: 'openai', model: 'phase-model', effort: 'high' });
        expect(record.row.phaseModels).toHaveLength(2);
    });
    it('writes v2 history, retains v1 reading and preserves a finished assessment after failure', () => {
        const config = {
            repository: 'acme/project',
            pr: 3,
            reviewer: 'skill://engineering/review',
            githubRun: '100',
            githubAttempt: 1,
            provider: 'openrouter',
            model: 'default',
            effort: '',
            packageVersion: '1.0.0',
        };
        const record = runRecord(config, { base: 'a'.repeat(40), head: 'b'.repeat(40) }, state, 1, 0.03, true);
        let body = withHistory('findings', null, record, config);
        const h = readHistory(body, config)!;
        expect(h.version).toBe(2);
        expect(h.assessment).not.toBeNull();
        const old = { ...h, version: 1 };
        body = body.replace(
            /contextrail-state:v2:[A-Za-z0-9+/=]+/,
            `contextrail-state:v1:${Buffer.from(JSON.stringify(old)).toString('base64')}`,
        );
        expect(readHistory(body, config)?.version).toBe(1);
        record.row.id = '101';
        record.assessment = null;
        const next = readHistory(withHistory('failed', { body }, record, config), config)!;
        expect(next.assessment?.run).toBe('100');
        expect(next.runs).toHaveLength(2);
    });
});

function pendingCoverageFixture() {
    const artifact: GitIdentity = {
        kind: 'git_comparison',
        repository: '/fixture',
        repositoryEnvironment: { status: 'unavailable', reason: 'no_remote' },
        base: { commit: 'a'.repeat(40), tree: 'c'.repeat(40), suppliedRef: 'base' },
        head: { commit: 'b'.repeat(40), tree: 'd'.repeat(40), suppliedRef: 'head' },
        limitations: [],
    };
    const runId = randomUUID(),
        scopeIdentity = 'sha256:' + 'e'.repeat(64),
        now = new Date().toISOString();
    const common = {
        runId,
        phase: 'assess' as const,
        workUnitId: 'unit',
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        status: 'complete' as const,
        inputRefs: [],
        artifact,
        scopeIdentity,
        assessmentIds: ['a', 'b', 'c'],
        evidenceRefs: [],
        limitations: [],
        stopReason: null,
        configuration: {},
        usageRefs: [],
    };
    const assess = createPhaseRecord({
        ...common,
        output: ['a', 'b', 'c'].map((id) => ({
            result: { assessmentId: id, disposition: 'evaluated', finding: 'binding_violation' },
            checks: [],
            findings: [],
        })),
    });
    const failedVerify = createPhaseRecord({
        ...common,
        phase: 'verify',
        status: 'failed',
        inputRefs: [{ ref: 'phase:assess:unit:1', hash: digest(assess) }],
        output: null,
        stopReason: 'provider_rejection',
    });
    return {
        common,
        assess,
        report: {
            runId,
            scopeIdentity,
            artifact,
            reviewer: { nodeId: 'skill://engineering/review', version: 1 },
            reviewStatus: 'incomplete',
            entries: ['a', 'b', 'c', 'd'].map((id) => ({
                assessmentId: id,
                nodeId: `context://engineering/${id}`,
                version: 1,
                result: { disposition: 'not_evaluated' },
            })),
            phases: [assess, failedVerify],
            findings: [
                {
                    findingId: 'candidate',
                    verified: false,
                    classification: 'binding_violation',
                    explanation: 'Unverified candidate must stay out of actionable findings.',
                },
            ],
            verification: { expected: 4, verified: 0, complete: false },
            decision: { exitCode: 2, reviewExit: 2, complete: false },
            execution: { stopReason: 'provider_rejection', calls: 4, providerUsage: [] },
        },
    };
}

describe('assessment progress before independent verification', () => {
    it('distinguishes completed assessment proposals from truly unexamined criteria without accepting candidates', () => {
        const { report } = pendingCoverageFixture(),
            before = JSON.stringify(report);
        expect(assessmentCoverage(report)).toMatchObject({
            total: 4,
            assessed: 3,
            currentAssessments: 3,
            awaitingVerification: 3,
            needsReassessment: 0,
            verified: 0,
            unexamined: 1,
        });
        const comment = renderReviewComment(report),
            summary = renderActionSummary(report);
        expect(comment).toContain(
            'Assessed 3/4; awaiting verification 3; needs reassessment 0; verified 0; unexamined 1.',
        );
        expect(comment).toContain('Recorded assessment proposals are not accepted review findings');
        expect(comment).not.toContain('Unverified candidate must stay out');
        expect(comment).not.toContain('#### Governed findings');
        expect(summary).toContain(
            '| Assessed / awaiting verification / needs reassessment / unexamined | 3 / 3 / 0 / 1 |',
        );
        expect(comment.indexOf('Assessment coverage')).toBeLessThan(comment.indexOf('<summary>Run details'));
        expect(JSON.stringify(report)).toBe(before);
        expect(report.decision.exitCode).toBe(2);
        expect(report.verification.verified).toBe(0);
    });
    it('counts independently accepted unresolved judgments as checked rather than pending', () => {
        const { report, common } = pendingCoverageFixture();
        report.entries = report.entries.slice(0, 1);
        report.entries[0]!.result.disposition = 'unresolved';
        const assess = createPhaseRecord({
            ...common,
            assessmentIds: ['a'],
            output: [{ result: { assessmentId: 'a', disposition: 'unresolved' }, checks: [], findings: [] }],
        });
        const verify = createPhaseRecord({
            ...common,
            phase: 'verify',
            assessmentIds: ['a'],
            inputRefs: [{ ref: 'phase:assess:unit:1', hash: digest(assess) }],
            output: [{ assessmentId: 'a', disposition: 'accept' }],
        });
        report.phases = [assess, verify];
        report.verification = { expected: 1, verified: 1, complete: true };
        report.execution.stopReason = 'finished';
        const before = JSON.stringify(report);
        expect(assessmentCoverage(report)).toMatchObject({
            assessed: 1,
            verified: 1,
            awaitingVerification: 0,
            needsReassessment: 0,
            unexamined: 0,
            entries: [{ assessmentId: 'a', status: 'verified_unresolved' }],
        });
        const comment = renderReviewComment(report);
        expect(comment).toContain(
            'Assessed 1/1; awaiting verification 0; needs reassessment 0; verified 1; unexamined 0.',
        );
        expect(comment).toContain('including confirmed evidence gaps; it does not mean the requirement is satisfied');
        expect(comment).toContain('Assessment incomplete');
        expect(comment).not.toContain('#### Governed findings');
        expect(report.decision.exitCode).toBe(2);
        expect(JSON.stringify(report)).toBe(before);
    });
    it('marks a completed unresolved verification as needing reassessment rather than awaiting work', () => {
        const { report, common } = pendingCoverageFixture();
        report.entries = report.entries.slice(0, 1);
        report.entries[0]!.result.disposition = 'unresolved';
        const assess = createPhaseRecord({
            ...common,
            assessmentIds: ['a'],
            output: [{ result: { assessmentId: 'a', disposition: 'evaluated' }, checks: [], findings: [] }],
        });
        const verify = createPhaseRecord({
            ...common,
            phase: 'verify',
            assessmentIds: ['a'],
            inputRefs: [{ ref: 'phase:assess:unit:1', hash: digest(assess) }],
            output: [{ assessmentId: 'a', disposition: 'unresolved', missingChecks: ['Inspect the consumer.'] }],
        });
        report.phases = [assess, verify];
        report.verification = { expected: 1, verified: 0, complete: false };
        report.execution.stopReason = 'finished';
        const before = JSON.stringify(report);
        expect(assessmentCoverage(report)).toMatchObject({
            assessed: 1,
            currentAssessments: 1,
            verified: 0,
            awaitingVerification: 0,
            needsReassessment: 1,
            unexamined: 0,
            entries: [{ assessmentId: 'a', status: 'needs_reassessment' }],
        });
        const comment = renderReviewComment(report);
        expect(comment).toContain(
            'Assessed 1/1; awaiting verification 0; needs reassessment 1; verified 0; unexamined 0.',
        );
        expect(comment).toContain('| Unresolved | Needs reassessment | 0 |');
        expect(report.decision.exitCode).toBe(2);
        expect(JSON.stringify(report)).toBe(before);
    });
    it('keeps historical examination visible after a later failed reassessment without looking verified', () => {
        const { report, common } = pendingCoverageFixture();
        const failed = createPhaseRecord({
            ...common,
            attempt: 2,
            assessmentIds: ['a'],
            status: 'failed',
            output: null,
            stopReason: 'provider_rejection',
        });
        report.phases.push(failed);
        expect(assessmentCoverage(report)).toMatchObject({
            assessed: 3,
            currentAssessments: 2,
            awaitingVerification: 2,
            needsReassessment: 1,
            verified: 0,
            unexamined: 1,
            entries: expect.arrayContaining([{ assessmentId: 'a', status: 'needs_reassessment' }]),
        });
        expect(renderReviewComment(report)).toContain(
            'Assessed 3/4; awaiting verification 2; needs reassessment 1; verified 0; unexamined 1.',
        );
    });
    it('shows saved partial proposals separately from complete handoffs and verified outcomes', () => {
        const { report, common } = pendingCoverageFixture();
        const partial = createPhaseRecord({
            ...common,
            status: 'failed',
            configuration: { kind: 'partial_assessment_progress' },
            output: {
                assessments: [{ result: { assessmentId: 'a', disposition: 'evaluated' }, checks: [], findings: [] }],
                remaining: ['b', 'c'],
            },
        });
        report.phases = [partial];
        const before = JSON.stringify(report);
        expect(assessmentCoverage(report)).toMatchObject({
            assessed: 0,
            savedProposals: 1,
            verified: 0,
            awaitingVerification: 0,
            unexamined: 3,
            entries: expect.arrayContaining([{ assessmentId: 'a', status: 'saved_proposal' }]),
        });
        expect(renderReviewComment(report)).toContain('Saved proposals: 1.');
        expect(renderReviewComment(report)).not.toContain('Unverified candidate must stay out');
        expect(JSON.stringify(report)).toBe(before);
        for (const output of [
            { assessments: [{ result: { assessmentId: 'a', disposition: 'evaluated' } }], remaining: ['a', 'c'] },
            { assessments: [{ result: { assessmentId: 'a', disposition: 'evaluated' } }], remaining: ['b'] },
        ]) {
            const invalid = createPhaseRecord({ ...partial, output });
            expect(assessmentCoverage({ ...report, phases: [invalid] })).toMatchObject({
                savedProposals: 0,
                unexamined: 4,
            });
        }
    });
    it('does not infer assessment progress from partial, corrupt, foreign or different-snapshot handoffs', () => {
        const { report, common, assess } = pendingCoverageFixture();
        const malformed = [
            { ...assess, runId: randomUUID() },
            { ...assess, scopeIdentity: 'sha256:' + '0'.repeat(64) },
            { ...assess, artifact: { ...assess.artifact, head: { ...assess.artifact.head, commit: 'f'.repeat(40) } } },
            { ...assess, outputHash: 'sha256:' + '0'.repeat(64) },
            createPhaseRecord({ ...common, status: 'incomplete', output: assess.output }),
            createPhaseRecord({ ...common, output: [{ result: { assessmentId: 'a', disposition: 'evaluated' } }] }),
        ];
        for (const phase of malformed)
            expect(assessmentCoverage({ ...report, phases: [phase] })).toMatchObject({
                assessed: 0,
                awaitingVerification: 0,
                verified: 0,
                unexamined: 4,
            });
    });
});

describe('individual governed results and prepared change overview', () => {
    it('renders all twenty original criteria once in order, with outcome separate from verification', () => {
        const { report: seed, common } = pendingCoverageFixture();
        const entries = Array.from({ length: 20 }, (_, i) => ({
            assessmentId: `r${i}`,
            nodeId: `context://engineering/rule-${i}`,
            version: 1,
            result: {
                disposition:
                    i === 0 || i === 5
                        ? 'evaluated'
                        : i === 1
                          ? 'not_applicable'
                          : i === 2
                            ? 'unresolved'
                            : 'not_evaluated',
                adherence: i === 0 ? 2 : i === 5 ? 0 : null,
                finding: i === 5 ? 'binding_violation' : 'none',
                explanation: `Rule ${i} explanation.`,
                correction: '',
            },
        }));
        const assigned = entries.filter((_, i) => i !== 3).map((e) => e.assessmentId);
        const assess = createPhaseRecord({
            ...common,
            assessmentIds: assigned,
            output: assigned.map((id) => ({
                result: {
                    assessmentId: id,
                    disposition:
                        entries.find((e) => e.assessmentId === id)!.result.disposition === 'not_evaluated'
                            ? 'evaluated'
                            : entries.find((e) => e.assessmentId === id)!.result.disposition,
                },
                checks: [],
                findings: [],
            })),
        });
        const verify = createPhaseRecord({
            ...common,
            phase: 'verify',
            assessmentIds: ['r0', 'r1', 'r2', 'r5'],
            inputRefs: [{ ref: 'phase:assess:unit:1', hash: digest(assess) }],
            output: ['r0', 'r1', 'r2', 'r5'].map((id) => ({ assessmentId: id, disposition: 'accept' })),
        });
        const report = {
            ...seed,
            entries,
            phases: [assess, verify],
            verification: { expected: 20, verified: 4, complete: false },
            findings: [
                {
                    findingId: 'accepted',
                    assessmentIds: ['r5'],
                    checkIds: ['check'],
                    classification: 'binding_violation',
                    explanation: 'Verified issue.',
                    consequence: 'Supported consequence.',
                    correction: 'Verified correction.',
                    verified: true,
                    locationRefs: [],
                },
                {
                    findingId: 'candidate',
                    assessmentIds: ['r4'],
                    classification: 'binding_violation',
                    explanation: 'Do not present this candidate as accepted.',
                    verified: false,
                    verification: { status: 'accepted' },
                },
            ],
        };
        for (const body of [renderReviewComment(report), renderActionSummary(report)]) {
            const rows = body.split('\n').filter((line) => line.startsWith('| context'));
            expect(rows).toHaveLength(20);
            expect(rows.map((row) => Number(row.replaceAll('\\', '').match(/rule-(\d+)/)![1]))).toEqual(
                Array.from({ length: 20 }, (_, i) => i),
            );
            expect(rows[0]).toContain('Adherent within reviewed scope | Checked');
            expect(rows[1]).toContain('Not applicable | Checked');
            expect(rows[2]).toContain('Unresolved | Checked; evidence needed');
            expect(rows[3]).toContain('Not evaluated | Not checked');
            expect(rows[4]).toContain('Not evaluated | Awaiting verification');
            expect(rows[5]).toContain('[1](#governed-findings)');
            expect(body).not.toContain('Do not present this candidate as accepted');
            expect(body.match(/\| Criterion \/ version \|/g)).toHaveLength(1);
            expect(body.indexOf('Governed findings')).toBeLessThan(body.indexOf('Assessment coverage'));
            expect(body.indexOf('Assessment coverage')).toBeLessThan(body.indexOf('Change summary'));
            expect(body.indexOf('Change summary')).toBeLessThan(body.indexOf('<summary>Run details'));
        }
    });
    it('labels an unverified positive canonical judgment as unverified rather than actionable', () => {
        const { report } = pendingCoverageFixture();
        Object.assign(report.entries[0]!.result, {
            disposition: 'evaluated',
            adherence: 0,
            finding: 'binding_violation',
            explanation: 'Candidate canonical judgment.',
            correction: 'Proposed fix.',
        });
        report.findings = [];
        const body = renderReviewComment(report),
            row = body.split('\n').find((line) => line.startsWith('| context'))!;
        expect(body).not.toContain('#### Governed findings');
        expect(row).toContain('Unverified violation judgment | Awaiting verification | 0 |');
        expect(row).toContain('Unverified judgment');
    });
    it('escapes every criterion note and path without losing table rows', () => {
        const { report } = pendingCoverageFixture();
        Object.assign(report.entries[0]!.result, {
            disposition: 'unresolved',
            explanation: '@here <script> ![x](https://bad) | injected\n# forged',
        });
        const changes = {
            base: report.artifact.base,
            head: report.artifact.head,
            status: 'complete',
            next: null,
            items: [{ kind: 'addition', head: { path: '@here|<script>.ts' } }],
            excludedPaths: [],
        };
        const body = renderReviewComment({ ...report, changes });
        expect(body).not.toContain('<script>');
        expect(body).not.toContain('![x]');
        expect(body).not.toContain('\n# forged');
        expect(body).toContain('&#64;here');
        expect(body.split('\n').filter((line) => line.startsWith('| context'))).toHaveLength(4);
    });
    it('counts all prepared inventory entries rather than the first bounded diff page', () => {
        const { report } = pendingCoverageFixture();
        const kinds = [
            ...Array(20).fill('addition'),
            ...Array(30).fill('modification'),
            ...Array(10).fill('deletion'),
            ...Array(25).fill('rename'),
            'type_change',
        ];
        const items = kinds.map((kind, i) => ({
            kind,
            offset: i,
            base: kind === 'addition' ? null : { path: `old/file-${i}.ts` },
            head: kind === 'deletion' ? null : { path: `new/file-${i}.ts` },
        }));
        const changes = {
            base: report.artifact.base,
            head: report.artifact.head,
            status: 'complete',
            next: null,
            items,
            excludedPaths: ['.env.local'],
        };
        const body = renderReviewComment({
            ...report,
            changes,
            diff: { status: 'truncated', items: [{ change: items[0] }] },
        });
        expect(body).toContain(
            'Complete permitted prepared inventory: 86 file changes recorded. Added 20; modified 31; deleted 10; renamed 25.',
        );
        expect(body).toContain('Modified includes 1 type change.');
        expect(body).toContain('78 additional file entries are omitted from this short path list');
        expect(body).toContain('1 credential-path entries were excluded');
    });
    it('keeps unknown kinds and finding labels as unknown even when they name object properties', () => {
        const { report } = pendingCoverageFixture();
        Object.assign(report.entries[0]!.result, { disposition: 'evaluated', finding: 'constructor', adherence: 0 });
        const changes = {
            base: report.artifact.base,
            head: report.artifact.head,
            status: 'complete',
            next: null,
            items: [{ kind: '__proto__', head: { path: 'unknown.ts' } }],
            excludedPaths: [],
        };
        const body = renderReviewComment({ ...report, changes });
        expect(body).toContain('Incomplete prepared inventory: 1 file changes recorded');
        expect(body).toContain('1 unclassified entries.');
        expect(body).toContain('Evaluated judgment');
        expect(body).not.toContain('NaN');
    });
    it('states incomplete and absent inventory limits without inferring totals', () => {
        const { report } = pendingCoverageFixture();
        const missing = renderReviewComment({ ...report, diff: { items: [{ change: { kind: 'addition' } }] } });
        expect(missing).toContain('Prepared change inventory is unavailable');
        expect(missing).not.toContain('Added 1');
        const changes = {
            base: report.artifact.base,
            head: report.artifact.head,
            status: 'truncated',
            next: { offset: 1 },
            items: [{ kind: 'addition', head: { path: 'captured.ts' } }],
            excludedPaths: [],
        };
        const partial = renderReviewComment({ ...report, changes });
        expect(partial).toContain('Incomplete prepared inventory: 1 file changes recorded');
        expect(partial).toContain('Remaining changes may be omitted; captured counts are not full-comparison totals');
        expect(
            renderReviewComment({
                ...report,
                changes: { ...changes, head: { ...report.artifact.head, commit: 'f'.repeat(40) } },
            }),
        ).toContain('Prepared change inventory is unavailable');
    });
});

describe('source-range developer accounts', () => {
    const citation = {
        ref: `evidence:${'a'.repeat(64)}`,
        quote: 'bad paragraph',
        start: 0,
        end: 13,
        provenance: { kind: 'source', side: 'head', commit: 'b'.repeat(40), path: 'README.md', object: 'c'.repeat(40) },
        location: { line: 7, column: 0 },
    };
    const account = (index: number) => ({
        ...state.findings[0]!,
        findingId: `finding-${index}`,
        assessmentIds: [`rule-${index}`],
        checkIds: [`check-${index}`],
        explanation: `Distinct supported account ${index}`,
        consequence: `Consequence ${index}`,
        correction: `Correction ${index}`,
        locationRefs: [structuredClone(citation)],
    });
    it('groups exact pinned ranges while preserving each account and all20 original criterion rows', () => {
        const findings = [account(0), account(1), account(2)];
        const input = {
            ...state,
            findings,
            entries: Array.from({ length: 20 }, (_, index) => ({
                ...state.entries[0]!,
                assessmentId: `rule-${index}`,
                nodeId: `context://engineering/rule-${index}`,
            })),
        };
        expect(groupDeveloperFindings(findings)).toHaveLength(1);
        const original = structuredClone(input);
        for (const body of [renderReviewComment(input), renderActionSummary(input)]) {
            expect(body).toContain('3 verified accounts at the same source range');
            for (let index = 0; index < 3; index++) {
                expect(body).toContain(`Distinct supported account ${index}`);
                expect(body).toContain(`Consequence ${index}`);
                expect(body).toContain(`Correction ${index}`);
                expect(body).toContain(`finding-${index}`);
                expect(body).toContain(`context\\://engineering/rule-${index}`);
            }
            expect(body.split('\n').filter((line) => line.startsWith('| context\\://engineering/rule-'))).toHaveLength(
                20,
            );
        }
        expect(input).toEqual(original);
    });
    it('keeps different pinned ranges separate and excludes unverified candidates', () => {
        const first = account(0),
            second = account(1),
            candidate = { ...account(2), verified: false };
        second.locationRefs[0]!.location.column = citation.quote.length;
        expect(groupDeveloperFindings([first, second, candidate])).toHaveLength(2);
        second.locationRefs[0]!.location.column = 0;
        second.locationRefs[0]!.provenance.object = 'd'.repeat(40);
        expect(groupDeveloperFindings([first, second])).toHaveLength(2);
        const unanchored = { ...account(3), locationRefs: [] };
        expect(groupDeveloperFindings([unanchored, { ...unanchored, findingId: 'other' }])).toHaveLength(2);
    });
    it('groups nested and overlapping pinned citations while retaining their own locations', () => {
        const broad = account(0),
            inner = account(1),
            overlap = account(2);
        broad.locationRefs[0]!.location.line = 6;
        broad.locationRefs[0]!.quote = 'intro\nbad paragraph\n';
        inner.locationRefs[0]!.quote = 'bad';
        overlap.locationRefs[0]!.location.column = 2;
        overlap.locationRefs[0]!.quote = 'd paragraph';
        const findings = [broad, inner, overlap];
        expect(groupDeveloperFindings(findings)).toHaveLength(1);
        for (const body of [renderReviewComment({ ...state, findings }), renderActionSummary({ ...state, findings })]) {
            expect(body).toContain('3 verified accounts at overlapping source ranges');
            expect(body).toContain('README\\.md\\:6\\:0–8\\:0');
            expect(body).toContain('README\\.md\\:7\\:0–7\\:3');
            expect(body).toContain('README\\.md\\:7\\:2–7\\:13');
            for (let index = 0; index < 3; index++) expect(body).toContain(`Distinct supported account ${index}`);
        }
        const adjacent = account(3);
        adjacent.locationRefs[0]!.location.line = 8;
        expect(groupDeveloperFindings([broad, adjacent])).toHaveLength(2);
        adjacent.locationRefs[0]!.location.line = 9;
        expect(groupDeveloperFindings([broad, adjacent])).toHaveLength(2);
        const otherCommit = account(4);
        otherCommit.locationRefs[0]!.provenance.commit = 'd'.repeat(40);
        expect(groupDeveloperFindings([inner, otherCommit])).toHaveLength(2);
        const otherPath = account(5);
        otherPath.locationRefs[0]!.provenance.path = 'other.md';
        expect(groupDeveloperFindings([inner, otherPath])).toHaveLength(2);
    });
    it('escapes every grouped account rather than treating shared source as trusted prose', () => {
        const findings = [account(0), { ...account(1), explanation: '@all <script> ![forged](https://bad)' }];
        const body = renderReviewComment({ ...state, findings });
        expect(body).toContain('&#64;all &lt;script&gt;');
        expect(body).not.toContain('![forged]');
        expect(body).toContain('Distinct supported account 0');
    });
});
