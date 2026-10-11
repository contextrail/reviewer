import { z } from 'zod';

export const selectionsSchema = z.strictObject({
    contextIds: z.array(z.string().startsWith('context://').max(500)).optional(),
    domains: z.array(z.strictObject({ domainId: z.string().min(1), includeDescendants: z.boolean() })).optional(),
});
export const reviewerSectionsSchema = z.strictObject({
    examples: z.array(z.unknown()).optional(),
    references: z.array(z.unknown()).optional(),
});
const relationshipSchema = z.object({ type: z.string(), targetId: z.string() }).passthrough();
export const publicationSchema = z
    .object({
        nodeId: z.string(),
        title: z.string().min(1),
        domainId: z.string().min(1),
        type: z.enum(['context', 'skill']),
        subtype: z.string(),
        status: z.literal('published'),
        detailLevel: z.literal('full'),
        version: z.number().int().positive(),
        relationships: z.array(relationshipSchema),
        content: z
            .object({
                kind: z.string(),
                body: z.string().optional(),
                instructions: z.string().optional(),
                reviewer: z.strictObject({ selections: selectionsSchema.optional() }).optional(),
            })
            .passthrough(),
    })
    .passthrough();
export type Publication = z.infer<typeof publicationSchema>;
export const scopeEntrySchema = z.strictObject({
    nodeId: z.string().startsWith('context://'),
    version: z.number().int().positive().nullable(),
    subtype: z.enum(['standard', 'guidance']).nullable(),
    contentHash: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/u)
        .nullable(),
    reasons: z.array(z.string().min(1)).min(1),
});
export type ScopeEntry = z.infer<typeof scopeEntrySchema>;
export const scopePageSchema = z.strictObject({
    reviewerId: z.string().startsWith('skill://'),
    publicationVersion: z.number().int().positive(),
    selectionsHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    scopeIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    complete: z.boolean(),
    totalMatched: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    entries: z.array(scopeEntrySchema),
    gaps: z.array(z.strictObject({ code: z.string(), reason: z.string() })),
});
export type ScopePage = z.infer<typeof scopePageSchema>;

/** Only authorized published reads; deterministic tests implement the same small boundary. */
export interface PublishedReader {
    read(name: 'get_skill' | 'get_context', args: Record<string, unknown>): Promise<unknown>;
}
export class PreparationReadError extends Error {
    constructor(
        readonly code: string,
        readonly diagnostic?: { phase?: string; status?: number; upstreamCode?: string | number; category?: string },
    ) {
        super(code);
    }
}
