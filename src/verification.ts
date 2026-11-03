import { z } from 'zod';
import { citationSchema, selectionSchema, type Citation, type EvidenceLedger } from './evidence.js';
import { exactIds } from './planning.js';
import type { AssessmentProposal } from './assessment.js';
export const verificationSchema = z.strictObject({
    entries: z.array(
        z.strictObject({
            assessmentId: z.string(),
            disposition: z
                .enum(['accept', 'revise', 'reject', 'unresolved'])
                .describe(
                    'Whether the ASSESSMENT is supported, not whether the code is compliant. Accept a correct assessment even when it establishes violations. accept requires no missing checks and all finding claims supported; otherwise revise/reject/unresolved.',
                ),
            reason: z.string().min(1),
            citations: z.array(citationSchema),
            missingChecks: z.array(z.string()),
            findings: z.array(
                z.strictObject({
                    findingId: z.string(),
                    accepted: z
                        .boolean()
                        .describe(
                            'True means this finding is supported by governing criteria and source, including a real code violation. False means the finding claim needs rejection or revision; it is not a code-approval flag.',
                        ),
                    suggestionAccepted: z
                        .boolean()
                        .describe(
                            'False unless this exact finding has a non-null proposedReplacement object and independent source inspection supports that replacement. A textual correction alone is not a replacement. Requires accepted=true.',
                        ),
                    explanation: z.string().min(1),
                }),
            ),
        }),
    ),
});
/** Model-only evidence selections; verificationSchema still validates resolved canonical quotations. */
export const verificationSelectionSchema = verificationSchema.extend({
    entries: z.array(verificationSchema.shape.entries.element.extend({ citations: z.array(selectionSchema) })),
});
export type VerificationEntry = Omit<z.infer<typeof verificationSchema>['entries'][number], 'citations'> & {
    citations: Citation[];
};
export function validateVerification(
    input: unknown,
    proposals: AssessmentProposal[],
    ledger: EvidenceLedger,
): VerificationEntry[] {
    const parsed = verificationSchema.parse(input);
    exactIds(
        parsed.entries.map((e) => e.assessmentId),
        proposals.map((p) => p.result.assessmentId),
    );
    return parsed.entries.map((e, entryIndex) => {
        const p = proposals.find((p) => p.result.assessmentId === e.assessmentId)!;
        exactIds(
            e.findings.map((f) => f.findingId),
            p.findings.map((f) => f.findingId),
        );
        const citations = e.citations.map((c, citationIndex) =>
            ledger.cite(c, ['entries', entryIndex, 'citations', citationIndex]),
        );
        if (
            !citations.some(
                (c) =>
                    c.provenance.kind === 'publication' &&
                    p.result.citations.some(
                        (o) =>
                            o.provenance.kind === 'publication' &&
                            o.provenance.nodeId === c.provenance.nodeId &&
                            o.provenance.version === c.provenance.version &&
                            o.provenance.contentHash === c.provenance.contentHash,
                    ),
            )
        )
            throw new Error('verification_governing_evidence_required');
        if (e.disposition === 'accept' && (e.missingChecks.length || e.findings.some((f) => !f.accepted)))
            throw new Error('verification_acceptance_inconsistent');
        if (
            e.disposition === 'accept' &&
            p.result.disposition === 'evaluated' &&
            !citations.some((c) => c.provenance.kind === 'source')
        )
            throw new Error('verification_source_required');
        if (
            e.findings.some(
                (f) =>
                    f.suggestionAccepted &&
                    (!f.accepted || !p.findings.find((o) => o.findingId === f.findingId)?.proposedReplacement),
            )
        )
            throw new Error('unproposed_suggestion_acceptance');
        return { ...e, citations };
    });
}
export const verificationInstructions = `You are the independent final verifier across the supplied assessment set. Check every supplied original criterion and compare related accounts for contradictions or overlapping claims while preserving each criterion judgment. Shared inspection may support multiple entries, but never turn missing proposals or duplicate findings into accepted coverage. Use evidencePack to locate EVERY original governing publication; read_publication returns bounded original evidence pages, and next must be followed when present. Inspect pinned source independently using read_source/diff/search_source. An index or partial page does not prove semantic coverage. Check classification as well as evidence: a direct unmet binding requirement is binding_violation; intended-behavior failure without a specific binding rule is behavioral_defect; a discretionary Guidance departure is guidance_departure. Accepting a finding must preserve its correct governing basis. Independently verify every supplied assessment, including clean adherence and not-applicable claims, against the ORIGINAL full pinned governing material and source. Do not merely check citation syntax or filter findings. Look for consequential obligations omitted by the assessment, incorrect applicability, unsupported certainty, contradictions, permitted alternatives and contrary evidence. Every context needs accept/revise/reject/unresolved, selected evidence and missing checks. Every citation must be {ref,startSegment,endSegment}, using the displayed 1-based inclusive segment indices from that exact evidence record. Segment indices are evidence-relative, not repository line numbers. Code extracts the exact original quotation; never supply or manufacture quote text or character offsets. Obtain the displayed segment view from supplied evidence or a source read rather than inferring indices from a proposal quotation.
Keep judgments bounded to the changed behavior and the cited requirement. A mandatory missing check must identify an applicable governing obligation and the concrete decision that missing evidence prevents. Do not turn hypothetical misconfiguration, unknown external consumers, optional hardening or unspecified guarantees into mandatory missing checks. When the documented input contract permits an alternative and inspected paths reveal no unmet obligation, accept a bounded source-supported assessment and state its limitations without demanding exhaustive proof. If source shows that a consequential consumer relies on a claim, inspect that boundary and report any supported unmet requirement.
Disposition evaluates the ASSESSMENT, not approval of the code: accept a correct assessment that proves a violation as well as a correct clean assessment. A real defect is a reason to accept its supported finding, not to reject the assessment. findings[].accepted=true means the finding claim is supported by governing criteria and source; it never means the code is acceptable. If any finding is unsupported or consequential checks are missing, choose revise/reject/unresolved for the context rather than accept. accept requires missingChecks=[] and accepted=true for every proposed finding. With no proposed findings, return findings=[].
findings[].suggestionAccepted is a separate decision about an actual machine-readable proposedReplacement object. It MUST be false if the finding has no proposedReplacement (or null), even when its prose correction is good. A correction string is advice, not a patch object. Set suggestionAccepted=true only after independently checking an existing proposedReplacement and accepting the finding itself. Never invent a replacement or finding ID during verification. Every proposed finding needs an independent acceptance decision. Independently inspect each proposed replacement for correctness against supporting code before setting suggestionAccepted; accepting a finding alone does not accept its patch. No execution occurred: do not claim runtime validation. When source inspection cannot settle a decisive claim, leave it unresolved and name the exact evidence. Do not add new company rules or use PR discussion/resolution as a waiver. Read-only tools cannot execute code or change authority. Submit all verification entries using submit_verification.`;
