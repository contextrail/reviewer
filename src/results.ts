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
export type AcceptedResult = Omit<z.infer<typeof resultSchema>, 'citations'> & {
    citations: Citation[];
    revision: number;
};
export type ResultSlot = PreparedState['entries'][number]['result'] | AcceptedResult;
export type ReviewEntry = Omit<PreparedState['entries'][number], 'result'> & { result: ResultSlot };
export type ReviewPolicy = { minAdherence: 0 | 1 | 2 | null; minConfidence: 1 | 2 | 3 | null; advisory: boolean };
export const DEFAULT_POLICY: ReviewPolicy = { minAdherence: null, minConfidence: null, advisory: false };

export function validateResult(input: unknown, entries: ReviewEntry[], ledger: EvidenceLedger): AcceptedResult {
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
    const citations = value.citations.map((citation, index) => {
        try {
            return ledger.cite(citation);
        } catch (error) {
            throw new Error(
                `citations.${index}: ${error instanceof Error ? error.message : 'Invalid pinned reference.'}`,
            );
        }
    });
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

/** Judgment is unchanged; only deterministic automation policy is applied here. */
export function decideExit(entries: ReviewEntry[], policy: ReviewPolicy, incomplete = false, executionFailure = false) {
    const reasons: Array<{ assessmentId: string | null; gate: string; blocking: boolean }> = [];
    let blocker = false;
    for (const entry of entries) {
        const r = entry.result;
        if (r.disposition === 'not_evaluated' || r.disposition === 'unresolved') {
            incomplete = true;
            reasons.push({ assessmentId: entry.assessmentId, gate: r.disposition, blocking: false });
            continue;
        }
        if (policy.minConfidence !== null && (r.confidence === null || r.confidence < policy.minConfidence)) {
            incomplete = true;
            reasons.push({ assessmentId: entry.assessmentId, gate: 'insufficient_confidence', blocking: false });
            continue;
        }
        if (r.disposition === 'evaluated') {
            const gate =
                r.finding === 'binding_violation' || r.finding === 'behavioral_defect'
                    ? r.finding
                    : policy.minAdherence !== null && r.adherence !== null && r.adherence < policy.minAdherence
                      ? 'min_adherence'
                      : null;
            if (gate) {
                const blocking = !policy.advisory;
                blocker ||= blocking;
                reasons.push({ assessmentId: entry.assessmentId, gate, blocking });
            }
        }
    }
    const reviewExit = blocker ? 1 : incomplete ? 2 : 0;
    // An execution/report failure is separate from the established review judgment.
    const exitCode = executionFailure ? 2 : reviewExit;
    const counts = {
        recorded: entries.length,
        evaluated: entries.filter((e) => e.result.disposition === 'evaluated').length,
        unresolved: entries.filter((e) => e.result.disposition === 'unresolved').length,
        notApplicable: entries.filter((e) => e.result.disposition === 'not_applicable').length,
        notEvaluated: entries.filter((e) => e.result.disposition === 'not_evaluated').length,
    };
    return { exitCode, reviewExit, complete: !incomplete, counts, reasons };
}
