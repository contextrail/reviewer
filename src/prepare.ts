import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    PreparationReadError,
    publicationSchema,
    reviewerSectionsSchema,
    scopePageSchema,
    type Publication,
    type PublishedReader,
    type ScopeEntry,
    type ScopePage,
} from './contracts.js';
import { fixGitIdentity } from './git.js';

export type GitIdentity = ReturnType<typeof fixGitIdentity>;
export type PreparationGap = { code: string; reason: string; diagnostic?: PreparationReadError['diagnostic'] };
export type PreparedState = {
    schemaVersion: 1;
    runId: string;
    createdAt: string;
    preparationStatus: 'prepared' | 'incomplete' | 'not_configured';
    reviewStatus: 'not_started';
    artifact: GitIdentity;
    reviewer: Publication | null;
    requestedReviewerId: string;
    scopeIdentity: string | null;
    expectedContextCount: number | null;
    entries: Array<
        ScopeEntry & {
            assessmentId: string;
            material: string | null;
            result: { disposition: 'not_evaluated'; adherence: null; confidence: null };
        }
    >;
    gaps: PreparationGap[];
    limitations: string[];
};
export function digest(value: unknown): string {
    return `sha256:${createHash('sha256')
        .update(
            JSON.stringify(value, (_key, item) =>
                item && typeof item === 'object' && !Array.isArray(item)
                    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')))
                    : item,
            ),
        )
        .digest('hex')}`;
}
export function assessmentId(
    reviewerId: string,
    reviewerVersion: number,
    contextId: string,
    contextVersion: number | null,
): string {
    return `assessment:${createHash('sha256')
        .update(JSON.stringify([reviewerId, reviewerVersion, contextId, contextVersion]))
        .digest('hex')}`;
}

/** Fixed artifact is captured before any retrieval; the reader cannot change it. */
export async function prepareReview(options: {
    repository: string;
    base: string;
    head: string;
    reviewerId: string;
    reader: PublishedReader;
    artifact?: GitIdentity;
}) {
    const artifact = options.artifact ?? fixGitIdentity(options.repository, options.base, options.head);
    if (!options.reviewerId.startsWith('skill://')) throw new Error('Use a published skill:// reviewer ID.');
    const runId = randomUUID();
    const directory = join(artifact.repository, '.contextrail', 'reviewer', runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state: PreparedState = {
        schemaVersion: 1,
        runId,
        createdAt: new Date().toISOString(),
        preparationStatus: 'incomplete',
        reviewStatus: 'not_started',
        artifact,
        reviewer: null,
        requestedReviewerId: options.reviewerId,
        scopeIdentity: null,
        expectedContextCount: null,
        entries: [],
        gaps: [],
        limitations: [
            'Prepared means retrieval and accounting only. No context has been evaluated; this is not a completed or passing review.',
            'The manifest fixes the authorized context/version set observed once during preparation. Later publications and domain changes apply to future runs.',
            'Non-context prerequisites are reported as unsupported. No conditional applicability judgments are made.',
        ],
    };
    const materials: Record<string, Publication> = {};
    const addGap = (code: string, reason: string, diagnostic?: PreparationReadError['diagnostic']) => {
        if (!state.gaps.some((gap) => gap.code === code && gap.reason === reason))
            state.gaps.push({ code, reason, ...(diagnostic ? { diagnostic } : {}) });
    };
    const materialPath = join(directory, 'publications.json');
    const statePath = join(directory, 'state.json');
    const checkpoint = async () => {
        // Material first: a crash can leave unreferenced material, never a reference to an unwritten file.
        await atomicJson(materialPath, materials);
        await atomicJson(statePath, state);
    };
    await checkpoint();
    let phase = 'reviewer';
    try {
        const reviewer = publicationSchema.parse(
            await options.reader.read('get_skill', {
                nodeId: options.reviewerId,
                detailLevel: 'full',
                responseFormat: 'json',
                includeAssessment: true,
            }),
        );
        if (
            reviewer.nodeId !== options.reviewerId ||
            reviewer.type !== 'skill' ||
            reviewer.subtype !== 'reviewer' ||
            !reviewer.content.instructions?.trim()
        )
            throw new PreparationReadError('invalid_reviewer_publication');
        reviewerSectionsSchema.parse(reviewer.content.sections ?? {});
        const assessment = reviewer.assessment;
        delete reviewer.assessment;
        state.reviewer = reviewer;
        await checkpoint();
        const selections = reviewer.content.reviewer?.selections ?? {};
        phase = 'scope';
        const page: ScopePage = scopePageSchema.parse(assessment);
        if (page.reviewerId !== reviewer.nodeId || page.publicationVersion !== reviewer.version)
            throw new PreparationReadError('scope_changed_or_invalid');
        // Preserve trustworthy counts and service gaps before any completeness validation.
        state.expectedContextCount = page.totalMatched;
        for (const gap of page.gaps) addGap(gap.code, gap.reason);
        if (page.selectionsHash !== digest(selections)) throw new PreparationReadError('scope_changed_or_invalid');
        const identity = digest({
            reviewerId: page.reviewerId,
            publicationVersion: page.publicationVersion,
            selectionsHash: page.selectionsHash,
            entries: page.entries,
            gaps: page.gaps,
        });
        // Incomplete service responses may retain the identity of an undisclosed full set.
        if (
            (page.complete ||
                (page.entries.length === page.totalMatched && page.offset === 0 && page.nextOffset === null)) &&
            page.scopeIdentity !== identity
        )
            throw new PreparationReadError('scope_changed_or_invalid');
        state.scopeIdentity = page.scopeIdentity;
        const seen = new Set<string>();
        for (const entry of page.entries) {
            if (seen.has(entry.nodeId)) throw new PreparationReadError('duplicate_scope_entry');
            seen.add(entry.nodeId);
            state.entries.push({
                ...entry,
                assessmentId: assessmentId(reviewer.nodeId, reviewer.version, entry.nodeId, entry.version),
                material: null,
                result: { disposition: 'not_evaluated', adherence: null, confidence: null },
            });
        }
        if (!page.complete && !page.gaps.length) addGap('scope_incomplete', 'enumeration');
        if (page.offset !== 0 || page.nextOffset !== null || page.entries.length !== page.totalMatched)
            addGap('scope_incomplete', 'enumeration');
        await checkpoint();
        state.entries.sort((a, b) => a.nodeId.localeCompare(b.nodeId, 'en'));
        if (!state.entries.length && !state.gaps.length) addGap('empty_scope', 'enumeration');
        phase = 'content';
        for (const entry of state.entries) {
            if (entry.version === null || entry.subtype === null || entry.contentHash === null) {
                addGap('context_unavailable', entry.nodeId);
                continue;
            }
            try {
                const content = publicationSchema.parse(
                    await options.reader.read('get_context', {
                        nodeId: entry.nodeId,
                        publicationVersion: entry.version,
                        detailLevel: 'full',
                        responseFormat: 'json',
                    }),
                );
                if (
                    content.nodeId !== entry.nodeId ||
                    content.version !== entry.version ||
                    content.type !== 'context' ||
                    content.subtype !== entry.subtype ||
                    digest(content.content) !== entry.contentHash
                )
                    throw new PreparationReadError('publication_changed_or_invalid');
                materials[entry.assessmentId] = content;
                entry.material = `publications.json#${entry.assessmentId}`;
            } catch (error) {
                addGap(
                    errorCode(error),
                    entry.nodeId,
                    error instanceof PreparationReadError ? error.diagnostic : undefined,
                );
                if (errorCode(error) === 'mcp_cancelled' || errorCode(error) === 'mcp_timeout') {
                    await checkpoint();
                    throw error;
                }
            }
            await checkpoint();
        }
        phase = 'final_reviewer_check';
        const identitySchema = publicationSchema
            .pick({
                nodeId: true,
                title: true,
                domainId: true,
                type: true,
                subtype: true,
                status: true,
                version: true,
            })
            .strip();
        const finalReviewer = identitySchema.parse(
            await options.reader.read('get_skill', {
                nodeId: reviewer.nodeId,
                publicationVersion: reviewer.version,
                detailLevel: 'summary',
                responseFormat: 'json',
            }),
        );
        if (digest(finalReviewer) !== digest(identitySchema.parse(reviewer)))
            throw new PreparationReadError('publication_changed_or_invalid');
        if (!state.gaps.length) state.preparationStatus = 'prepared';
    } catch (error) {
        addGap(errorCode(error), phase, error instanceof PreparationReadError ? error.diagnostic : undefined);
    }
    if (state.gaps.some((gap) => gap.code === 'preparation_not_configured')) state.preparationStatus = 'not_configured';
    await checkpoint();
    return { state, statePath, materialPath };
}
function errorCode(error: unknown): string {
    return error instanceof PreparationReadError ? error.code : 'contract_validation_failed';
}

export async function atomicJson(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}
