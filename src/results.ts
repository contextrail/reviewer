import { z } from 'zod';
import { citationSchema, type Citation, type EvidenceLedger } from './evidence.js';
import type { PreparedState } from './prepare.js';

export const resultSchema = z.strictObject({
    assessmentId: z.string(),
    revisionOf: z.number().int().positive().nullable(),
    disposition: z.enum(['evaluated', 'not_applicable', 'unresolved']),
    adherence: z.union([z.literal(0), z.literal(1), z.literal(2), z.null()]),
    confidence: z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]),
    confidenceReason: z.string().min(1),
    finding: z.enum(['none', 'binding_violation', 'behavioral_defect', 'guidance_departure']),
    explanation: z.string().min(1),
    consequence: z.string(),
    correction: z.string(),
    limitations: z.array(z.string()),
    citations: z.array(citationSchema),
});
/** Models judge applicability and confidence; code derives aggregate outcomes from finding accounts. */
export function modelResultSchema() {
    return resultSchema.pick({
        assessmentId: true,
        disposition: true,
        confidence: true,
        confidenceReason: true,
        explanation: true,
        limitations: true,
    });
}
export type AcceptedResult = Omit<z.infer<typeof resultSchema>, 'citations'> & {
    citations: Citation[];
    revision: number;
};
type ResultSlot = PreparedState['entries'][number]['result'] | AcceptedResult;
export type ReviewEntry = Omit<PreparedState['entries'][number], 'result'> & { result: ResultSlot };
export const reviewPolicySchema = z.strictObject({ enforcement: z.enum(['advisory', 'required', 'strict']) });
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;
export const DEFAULT_POLICY: ReviewPolicy = { enforcement: 'advisory' };

function validateJudgment(value: z.infer<typeof resultSchema>) {
    if (value.disposition === 'evaluated') {
        if (value.adherence === null || value.confidence === null)
            throw new Error(
                'Evaluated judgments require adherence and confidence with reasons. Missing decisive evidence must be unresolved.',
            );
        if (value.finding !== 'none' && value.adherence === 2)
            throw new Error(
                'A supported unmet criterion needs adherence 0 or 1; satisfied permitted alternatives use 2 and finding none.',
            );
        if (value.adherence < 2 && value.finding === 'none')
            throw new Error(
                'Adherence below 2 requires a supported specific unmet criterion. Missing evidence is unresolved.',
            );
    } else if (
        value.adherence !== null ||
        value.finding !== 'none' ||
        (value.disposition === 'unresolved' && value.confidence !== null)
    )
        throw new Error(
            'Unresolved/nonapplicable judgments have null adherence and no proven finding; unresolved confidence is null.',
        );
}

export function validateResult(
    input: unknown,
    entries: ReviewEntry[],
    ledger: EvidenceLedger,
    path: Array<string | number> = [],
): AcceptedResult {
    const parsed = resultSchema.safeParse(input);
    if (!parsed.success)
        throw new Error(
            `Result shape invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code}`).join('; ')}. Correct these fields and resubmit this result.`,
        );
    const value = parsed.data;
    const entry = entries.find((e) => e.assessmentId === value.assessmentId);
    if (!entry) throw new Error('Unknown assessmentId. Use the expected checklist identity.');
    const currentRevision = 'revision' in entry.result ? entry.result.revision : null;
    if (value.revisionOf !== currentRevision)
        throw new Error(
            `Duplicate/stale update. To explicitly correct this entry, set revisionOf to ${currentRevision ?? 'null'}.`,
        );
    if (!entry.material) throw new Error('Pinned publication unavailable; this entry cannot be assessed.');
    validateJudgment(value);
    const citations = value.citations.map((citation, index) => ledger.cite(citation, [...path, 'citations', index]));
    if (
        !citations.some(
            (c) =>
                c.provenance.kind === 'publication' &&
                c.provenance.nodeId === entry.nodeId &&
                c.provenance.version === entry.version,
        )
    )
        throw new Error('Cite an exact governing passage from this entry’s pinned publication.');
    if (value.disposition === 'evaluated' && !citations.some((c) => c.provenance.kind === 'source'))
        throw new Error(
            'Evaluated judgments require concrete pinned source evidence from read_source. Navigation/search alone is not assessment evidence.',
        );
    if (value.finding !== 'none' && (!value.consequence.trim() || !value.correction.trim()))
        throw new Error('Findings need a concrete consequence and proportionate correction.');
    return { ...value, citations, revision: (currentRevision ?? 0) + 1 };
}

function resultGate(result: ResultSlot) {
    if (result.disposition === 'not_evaluated' || result.disposition === 'unresolved')
        return { name: result.disposition, incomplete: true };
    if (
        result.disposition === 'evaluated' &&
        (result.finding === 'binding_violation' || result.finding === 'behavioral_defect')
    )
        return { name: result.finding, incomplete: false };
    return null;
}

type PolicyFinding = { verified: boolean; classification: string; assessmentIds: string[] };
type PolicyReason = { assessmentId: string | null; gate: string; blocking: boolean };

function addFindingReasons(
    entries: ReviewEntry[],
    findings: PolicyFinding[],
    policy: ReviewPolicy,
    reasons: PolicyReason[],
) {
    for (const finding of findings) {
        if (!finding.verified || !['binding_violation', 'behavioral_defect'].includes(finding.classification)) continue;
        for (const id of finding.assessmentIds) {
            if (
                !entries.some((entry) => entry.assessmentId === id) ||
                reasons.some((reason) => reason.assessmentId === id && reason.gate === finding.classification)
            )
                continue;
            reasons.push({
                assessmentId: id,
                gate: finding.classification,
                blocking: policy.enforcement !== 'advisory',
            });
        }
    }
}

function entryPolicyReasons(entries: ReviewEntry[], policy: ReviewPolicy): PolicyReason[] {
    return entries.flatMap((entry) => {
        const gate = resultGate(entry.result);
        if (!gate) return [];
        const blocking =
            gate.name !== 'not_evaluated' &&
            (gate.incomplete ? policy.enforcement === 'strict' : policy.enforcement !== 'advisory');
        return [{ assessmentId: entry.assessmentId, gate: gate.name, blocking }];
    });
}

/** Judgment is unchanged; only deterministic automation policy is applied here. */
export function decideExit(
    entries: ReviewEntry[],
    policy: ReviewPolicy,
    incomplete = false,
    executionFailure = false,
    findings: PolicyFinding[] = [],
) {
    const reasons = entryPolicyReasons(entries, policy);
    incomplete ||= reasons.some((reason) => ['unresolved', 'not_evaluated'].includes(reason.gate));
    let blocker = reasons.some((reason) => reason.blocking);
    addFindingReasons(entries, findings, policy, reasons);
    blocker ||= reasons.some((reason) => reason.blocking);
    const unavailable =
        executionFailure || !entries.length || entries.some((entry) => entry.result.disposition === 'not_evaluated');
    if (incomplete && !unavailable && policy.enforcement === 'strict' && !reasons.some((reason) => reason.blocking)) {
        reasons.push({ assessmentId: null, gate: 'incomplete_assessment', blocking: true });
        blocker = true;
    }
    const reviewExit = blocker ? 1 : 0;
    // An unavailable review remains an error even when judgments are advisory.
    const exitCode = unavailable ? 2 : reviewExit;
    const counts = {
        recorded: entries.length,
        evaluated: entries.filter((e) => e.result.disposition === 'evaluated').length,
        unresolved: entries.filter((e) => e.result.disposition === 'unresolved').length,
        notApplicable: entries.filter((e) => e.result.disposition === 'not_applicable').length,
        notEvaluated: entries.filter((e) => e.result.disposition === 'not_evaluated').length,
    };
    return { exitCode, reviewExit, complete: !incomplete && !unavailable, counts, reasons };
}
