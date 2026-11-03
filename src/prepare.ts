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
import { fixGitIdentity, readableDiff } from './git.js';
import { FixedSnapshotSource, type ChangeInventory, type DiffPage, type SourceLimits } from './source.js';

export type GitIdentity = ReturnType<typeof fixGitIdentity>;
type PreparationGap = { code: string; reason: string; diagnostic?: PreparationReadError['diagnostic'] };
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
    diff?: DiffPage;
    changes?: ChangeInventory;
};
// Keep this serializer compatible with the API scope contract. The standalone reviewer
// cannot import unpublished API internals merely to share this small boundary implementation.
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

/** Recover the immutable preparation input from the expanded final artifact inventory. */
export function preparationManifest(manifest: Record<string, unknown>): Record<string, unknown> {
    const { files, capture: _capture, ...prepared } = manifest;
    const inventory = files && typeof files === 'object' ? (files as Record<string, unknown>) : {};
    const originalFiles = Object.fromEntries(
        ['diff.patch', 'preparation.md']
            .filter((name) => inventory[name] !== undefined)
            .map((name) => [name, inventory[name]]),
    );
    if (Object.keys(originalFiles).length) prepared.files = originalFiles;
    return prepared;
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

/** Preserve structured published entries verbatim; prose interpretation belongs to model phases. */
export function structuredRequirements(publication: Publication) {
    const entries: Array<{ path: string; value: unknown }> = [];
    for (const field of ['rules', 'checklist'] as const) {
        const values = publication.content[field];
        if (Array.isArray(values))
            values.forEach((value, index) => entries.push({ path: `/content/${field}/${index}`, value }));
    }
    return entries;
}

function initialPreparationState(artifact: GitIdentity, reviewerId: string, runId: string): PreparedState {
    return {
        schemaVersion: 1,
        runId,
        createdAt: new Date().toISOString(),
        preparationStatus: 'incomplete',
        reviewStatus: 'not_started',
        artifact,
        reviewer: null,
        requestedReviewerId: reviewerId,
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
}

type AddGap = (code: string, reason: string, diagnostic?: PreparationReadError['diagnostic']) => void;

function assertScopeIdentity(page: ScopePage, selections: unknown) {
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
}

async function prepareScope(
    reviewer: Publication,
    assessment: unknown,
    state: PreparedState,
    addGap: AddGap,
    checkpoint: () => Promise<void>,
) {
    const selections = reviewer.content.reviewer?.selections ?? {};
    const page: ScopePage = scopePageSchema.parse(assessment);
    if (page.reviewerId !== reviewer.nodeId || page.publicationVersion !== reviewer.version)
        throw new PreparationReadError('scope_changed_or_invalid');
    // Preserve trustworthy counts and service gaps before any completeness validation.
    state.expectedContextCount = page.totalMatched;
    for (const gap of page.gaps) addGap(gap.code, gap.reason);
    assertScopeIdentity(page, selections);
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
}
async function prepareContextMaterials(
    reader: PublishedReader,
    state: PreparedState,
    materials: Record<string, Publication>,
    addGap: AddGap,
    checkpoint: () => Promise<void>,
) {
    for (const entry of state.entries) {
        if (entry.version === null || entry.subtype === null || entry.contentHash === null) {
            addGap('context_unavailable', entry.nodeId);
            continue;
        }
        try {
            const content = publicationSchema.parse(
                await reader.read('get_context', {
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
}
async function confirmReviewerIdentity(reader: PublishedReader, reviewer: Publication) {
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
        await reader.read('get_skill', {
            nodeId: reviewer.nodeId,
            publicationVersion: reviewer.version,
            detailLevel: 'summary',
            responseFormat: 'json',
        }),
    );
    if (digest(finalReviewer) !== digest(identitySchema.parse(reviewer)))
        throw new PreparationReadError('publication_changed_or_invalid');
}

async function prepareSourceArtifacts(
    state: PreparedState,
    options: { sourceLimits?: Partial<SourceLimits>; signal?: AbortSignal },
    directory: string,
    addGap: AddGap,
) {
    const source = new FixedSnapshotSource(state.artifact, options.sourceLimits);
    state.changes = await source.changeInventory({ signal: options.signal });
    if (state.changes.status !== 'complete') {
        addGap('change_inventory_incomplete', state.changes.reason ?? 'Changed-file metadata capture is incomplete.');
        if (state.preparationStatus === 'prepared') state.preparationStatus = 'incomplete';
    }
    try {
        state.diff = await source.diff({}, { signal: options.signal });
    } catch {
        addGap('diff_unavailable', 'Fixed comparison hunks could not be prepared.');
        state.preparationStatus = 'incomplete';
    }
    const readable = await writePreparationArtifacts(state, directory, { timeoutMs: options.sourceLimits?.timeoutMs });
    if (readable.status === 'unavailable') {
        addGap('readable_diff_unavailable', 'See preparation.md for the readable artifact limit.');
        if (state.preparationStatus === 'prepared') state.preparationStatus = 'incomplete';
    }
    return readable;
}

/** Fixed artifact is captured before any retrieval; the reader cannot change it. */
export async function prepareReview(options: {
    repository: string;
    base: string;
    head: string;
    reviewerId: string;
    reader: PublishedReader;
    artifact?: GitIdentity;
    sourceLimits?: Partial<SourceLimits>;
    signal?: AbortSignal;
}) {
    const artifact = options.artifact ?? fixGitIdentity(options.repository, options.base, options.head);
    if (!options.reviewerId.startsWith('skill://')) throw new Error('Use a published skill:// reviewer ID.');
    const runId = randomUUID();
    const directory = join(artifact.repository, '.contextrail', 'reviewer', runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = initialPreparationState(artifact, options.reviewerId, runId);
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
        phase = 'scope';
        await prepareScope(reviewer, assessment, state, addGap, checkpoint);
        phase = 'content';
        await prepareContextMaterials(options.reader, state, materials, addGap, checkpoint);
        phase = 'final_reviewer_check';
        await confirmReviewerIdentity(options.reader, reviewer);
        if (!state.gaps.length) state.preparationStatus = 'prepared';
    } catch (error) {
        addGap(errorCode(error), phase, error instanceof PreparationReadError ? error.diagnostic : undefined);
    }
    if (state.gaps.some((gap) => gap.code === 'preparation_not_configured')) state.preparationStatus = 'not_configured';
    const readable = await prepareSourceArtifacts(state, options, directory, addGap);
    await checkpoint();
    const manifestPath = join(directory, 'manifest.json');
    await atomicJson(manifestPath, {
        contractVersion: 1,
        runId,
        artifact,
        reviewer: state.reviewer,
        scopeIdentity: state.scopeIdentity,
        expectedContextCount: state.expectedContextCount,
        entries: state.entries.map(({ result: _result, ...entry }) => entry),
        publicationsHash: digest(materials),
        structuredRequirements: Object.fromEntries(
            Object.entries(materials).map(([id, publication]) => [id, structuredRequirements(publication)]),
        ),
        diffHash: digest(state.diff ?? null),
        changesHash: digest(state.changes),
        preparationStatus: state.preparationStatus,
        gaps: state.gaps,
        files: readable.files,
    });
    return { state, statePath, materialPath, manifestPath };
}

/** Human entry point for preparation; can also backfill a completed run without modifying its assessment. */
export async function writePreparationArtifacts(
    state: PreparedState,
    directory: string,
    options: { timeoutMs?: number; maxBytes?: number } = {},
) {
    const hashes: Record<string, string> = {};
    const write = async (name: string, text: string) => {
        const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
            await rename(temporary, join(directory, name));
            hashes[name] = `sha256:${createHash('sha256').update(text).digest('hex')}`;
        } finally {
            await rm(temporary, { force: true });
        }
    };
    const escaped = (value: string) =>
        value.replace(/[\\`*_[\]<>]/gu, (character) => `\\${character}`).replace(/[\r\n]/gu, ' ');
    const lines = [
        '# Review preparation',
        '',
        'These are the fixed review inputs, not assessment conclusions.',
        '',
        `Base: \`${state.artifact.base.commit}\``,
        `Head: \`${state.artifact.head.commit}\``,
        `Reviewer: ${escaped(state.requestedReviewerId)}${state.reviewer ? ` (publication ${state.reviewer.version})` : ' (unavailable)'}`,
        '',
        'Open [diff.patch](diff.patch) for the normal Git diff. [state.json](state.json) and [publications.json](publications.json) retain machine-readable provenance and pinned guidance.',
        '',
        '## Changes',
        '',
    ];
    let status: 'available' | 'unavailable' = 'available';
    try {
        const diff = readableDiff(state.artifact, options);
        await write('diff.patch', diff.patch);
        const fence = '`'.repeat(Math.max(3, ...(diff.stat.match(/`+/gu) ?? []).map((match) => match.length + 1)));
        lines.push(`${fence}text`, diff.stat || '(No permitted changed files.)', fence, '', 'Changed paths:', '');
        lines.push(
            ...(diff.files.length ? diff.files.map((path) => `- ${escaped(JSON.stringify(path))}`) : ['- None.']),
        );
        lines.push('', '## Omissions and limits', '');
        lines.push(
            ...(diff.excludedPaths.length
                ? diff.excludedPaths.map(
                      (path) => `- Credential-path content excluded: ${escaped(JSON.stringify(path))}`,
                  )
                : ['- No conventional credential paths were excluded.']),
        );
        lines.push(
            '- Binary files and submodules retain normal Git markers/pointers; their contents are not expanded.',
        );
        lines.push(
            `- Full permitted diff: ${Buffer.byteLength(diff.patch)} bytes. Output bound: ${options.maxBytes ?? 16 * 1024 * 1024} bytes; total capture timeout: ${options.timeoutMs ?? 30000} ms. No silent truncation.`,
        );
    } catch {
        status = 'unavailable';
        await rm(join(directory, 'diff.patch'), { force: true });
        lines.push(
            'The full readable diff is unavailable: Git identity, object availability, UTF-8 representation, output bound or timeout prevented complete capture. No partial diff.patch is presented as complete.',
            '',
            '## Omissions and limits',
            '',
        );
        lines.push(
            `- Output bound: ${options.maxBytes ?? 16 * 1024 * 1024} bytes; total capture timeout: ${options.timeoutMs ?? 30000} ms.`,
        );
    }
    lines.push(
        '',
        '## Governed scope',
        '',
        `Expected contexts: ${state.expectedContextCount ?? 'unavailable'}; recorded contexts: ${state.entries.length}.`,
        '',
    );
    lines.push(
        ...state.entries.map(
            (entry) =>
                `- ${escaped(entry.nodeId)} @ ${entry.version ?? 'unavailable'} (${entry.subtype ?? 'unavailable'})`,
        ),
    );
    if (state.gaps.length)
        lines.push(
            '',
            'Preparation gaps:',
            '',
            ...state.gaps.map((gap) => `- ${escaped(gap.code)}: ${escaped(gap.reason)}`),
        );
    await write('preparation.md', lines.join('\n') + '\n');
    return {
        status,
        files: hashes,
        diffPath: join(directory, 'diff.patch'),
        preparationPath: join(directory, 'preparation.md'),
    };
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
