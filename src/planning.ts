import { z } from 'zod';
import { CitationError, citationSchema, modelEvidence, type Citation, type EvidenceLedger } from './evidence.js';
import { digest } from './prepare.js';
import type { ReviewEntry } from './results.js';
const planSchema = z.strictObject({
    entries: z.array(
        z.strictObject({
            assessmentId: z.string(),
            applicability: z.enum(['applicable', 'not_applicable', 'unresolved']),
            reason: z.string().min(1),
            workUnit: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u),
            checks: z
                .array(
                    z.strictObject({
                        passage: citationSchema.describe(
                            'ref must be an exact guidance[].evidence[].ref for this context. assessmentId, nodeId and contentHash are not evidence refs. quote must be exact unique text from that evidence.',
                        ),
                        interpretation: z.string().min(1),
                    }),
                )
                .min(1),
            surfaces: z.array(z.string()),
            evidenceNeeds: z.array(z.string()),
        }),
    ),
});
type PlannedCheck = { checkId: string; assessmentId: string; passageRef: Citation; interpretation: string };
export type PlanEntry = Omit<z.infer<typeof planSchema>['entries'][number], 'checks'> & { checks: PlannedCheck[] };
export type ReviewPlan = { entries: PlanEntry[] };
export function exactIds(actual: string[], expected: string[]) {
    if (
        new Set(actual).size !== actual.length ||
        actual.length !== expected.length ||
        actual.some((id) => !expected.includes(id))
    )
        throw new Error('assessment_coverage_mismatch');
}
export type PlanCitationCorrection = {
    assessmentId: string;
    entryIndex: number;
    checkIndex: number;
    code:
        | 'citation_unknown'
        | 'citation_absent'
        | 'citation_ambiguous'
        | 'citation_range_invalid'
        | 'wrong_governing_publication'
        | 'citation_invalid';
    rejectedRefHash: string;
    allowedRefs: Array<ReturnType<typeof modelEvidence> & { path: string; nodeId: string; version: number }>;
    allowedRefsOmitted: number;
};
/** Package-created correction metadata; rejected model text and quotations are never copied. */
export class PlanCitationError extends Error {
    readonly code = 'plan_citations_invalid';
    constructor(
        readonly corrections: PlanCitationCorrection[],
        readonly omittedCount: number,
    ) {
        super('plan_citations_invalid');
        this.name = 'PlanCitationError';
    }
}
function governingRefs(entry: ReviewEntry, ledger: EvidenceLedger) {
    const all = Object.values(ledger.records)
        .filter(
            (record) =>
                record.provenance.kind === 'publication' &&
                record.provenance.nodeId === entry.nodeId &&
                record.provenance.version === entry.version &&
                record.provenance.contentHash === entry.contentHash,
        )
        .map((record) => ({
            ...modelEvidence(record),
            path: String(record.provenance.path ?? ''),
            nodeId: entry.nodeId,
            version: entry.version!,
        }));
    const preferred = all.filter(
        (record) =>
            record.path === '/content/body' ||
            record.path.startsWith('/content/rules/') ||
            record.path.startsWith('/content/checklist/'),
    );
    return (preferred.length ? preferred : all).sort(
        (a, b) => a.path.localeCompare(b.path) || a.ref.localeCompare(b.ref),
    );
}
function ownGoverningPassage(entry: ReviewEntry, passage: Citation) {
    return (
        passage.provenance.kind === 'publication' &&
        passage.provenance.nodeId === entry.nodeId &&
        passage.provenance.version === entry.version &&
        passage.provenance.contentHash === entry.contentHash
    );
}
function resolveGoverningPassage(
    selection: z.infer<typeof citationSchema>,
    entry: ReviewEntry,
    ledger: EvidenceLedger,
): { passage: Citation; code?: never } | { passage?: never; code: PlanCitationCorrection['code'] } {
    try {
        const passage = ledger.cite(selection);
        if (!ownGoverningPassage(entry, passage)) return { code: 'wrong_governing_publication' };
        return { passage };
    } catch (error) {
        if (error instanceof CitationError) return { code: error.code };
        const message = error instanceof Error ? error.message : '';
        if (message.startsWith('Unknown evidence ref')) return { code: 'citation_unknown' };
        if (message.startsWith('Quote absent')) return { code: 'citation_absent' };
        if (message.startsWith('Quote ambiguous')) return { code: 'citation_ambiguous' };
        return { code: 'citation_invalid' };
    }
}
export function validatePlan(
    input: unknown,
    entries: ReviewEntry[],
    ledger: EvidenceLedger,
    structured: Record<string, Array<{ path: string; value: unknown }>> = {},
): ReviewPlan {
    const parsed = planSchema.parse(input);
    exactIds(
        parsed.entries.map((e) => e.assessmentId),
        entries.map((e) => e.assessmentId),
    );
    const corrections: PlanCitationCorrection[] = [];
    let omittedCount = 0;
    const plan: ReviewPlan = {
        entries: parsed.entries.map((e, entryIndex) => {
            const entry = entries.find((expected) => expected.assessmentId === e.assessmentId)!;
            const allowed = governingRefs(entry, ledger),
                checks: PlannedCheck[] = [];
            for (const [checkIndex, check] of e.checks.entries()) {
                const { passage, code } = resolveGoverningPassage(check.passage, entry, ledger);
                if (code) {
                    if (corrections.length < 100)
                        corrections.push({
                            assessmentId: entry.assessmentId,
                            entryIndex,
                            checkIndex,
                            code,
                            rejectedRefHash: digest(check.passage.ref),
                            allowedRefs: allowed.slice(0, 32),
                            allowedRefsOmitted: Math.max(0, allowed.length - 32),
                        });
                    else omittedCount++;
                    continue;
                }
                checks.push({
                    checkId: `check:${digest([
                        e.assessmentId,
                        passage.ref,
                        passage.start,
                        passage.end,
                        passage.quote,
                        check.interpretation.trim(),
                    ]).slice(7)}`,
                    assessmentId: e.assessmentId,
                    passageRef: passage,
                    interpretation: check.interpretation,
                });
            }
            return { ...e, checks };
        }),
    };
    if (corrections.length || omittedCount) throw new PlanCitationError(corrections, omittedCount);
    for (const entry of plan.entries)
        for (const requirement of structured[entry.assessmentId] ?? []) {
            const prefix = requirement.path;
            if (
                !entry.checks.some(
                    (c) =>
                        typeof c.passageRef.provenance.path === 'string' &&
                        (c.passageRef.provenance.path === prefix ||
                            c.passageRef.provenance.path.startsWith(prefix + '/')),
                )
            )
                throw new Error('structured_requirement_unaccounted');
        }
    return plan;
}
