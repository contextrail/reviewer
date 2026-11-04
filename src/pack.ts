import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { publicationSchema, type Publication } from './contracts.js';
import { EvidenceLedger, modelEvidence, type Evidence } from './evidence.js';
import { digest, type PreparedState } from './prepare.js';
import { SourceAccessError, type FixedSnapshotSource, type ReadRequest } from './source.js';
import { MAX_PREPARATION_BYTES } from './git.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_READ_SEGMENTS = 200;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_EVIDENCE_BYTES = 512 * 1024;
const packReadSchema = z.strictObject({
    assessmentId: z.string().min(1),
    section: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
});
type PackReadRequest = z.infer<typeof packReadSchema>;
type PackCriterion = {
    assessmentId: string;
    nodeId: string;
    title: string | null;
    version: number | null;
    subtype: string | null;
    contentHash: string | null;
    reasons: string[];
    relationships: Publication['relationships'];
    available: boolean;
    sections: Array<{ index: number; path: string; ref: string; characters: number; bytes: number }>;
};
export type EvidencePack = {
    index: {
        contractVersion: 1;
        runId: string;
        scopeIdentity: string | null;
        preparationStatus: PreparedState['preparationStatus'];
        expectedContextCount: number | null;
        comparison: { base: string; head: string };
        criteria: PackCriterion[];
        changedFiles: PreparedState['changes'] | null;
        assets: { diff: 'diff.patch'; preparation: 'preparation.md'; publications: 'publications.json' };
        gaps: PreparedState['gaps'];
        limitations: string[];
    };
    markdown: string;
};
// Model reads address registered publications, never caller-provided filesystem paths.
const contents = new WeakMap<EvidencePack, Map<string, Evidence[]>>();
export type PackReadResult = {
    status: 'complete' | 'truncated' | 'unavailable';
    publication: Omit<PackCriterion, 'sections'> | null;
    sections: Array<{ index: number; path: string; offset: number; end: number; totalCharacters: number }>;
    evidence: ReturnType<typeof modelEvidence>[];
    next: PackReadRequest | null;
    reason?: string;
};

/** Reuse the sealed plain patch; source reads still supply citation evidence. */
export async function modelDiffEvidence(directory: string, expectedHash: unknown, fallback: PreparedState['diff']) {
    const omitted = (reason: 'artifact_unavailable' | 'model_diff_budget', bytes: number | null = null) => ({
        ...fallback,
        fullPatch: { status: 'omitted' as const, reason, bytes, maxBytes: 128 * 1024 },
    });
    if (expectedHash === undefined) return omitted('artifact_unavailable');
    if (typeof expectedHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedHash))
        throw new Error('upstream_artifact_changed');
    const file = await open(join(directory, 'diff.patch'), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
        throw new Error('upstream_artifact_changed');
    });
    let bytes: Buffer;
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_PREPARATION_BYTES) throw new Error('upstream_artifact_changed');
        bytes = Buffer.alloc(info.size + 1);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== info.size) throw new Error('upstream_artifact_changed');
        bytes = bytes.subarray(0, info.size);
    } finally {
        await file.close();
    }
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expectedHash)
        throw new Error('upstream_artifact_changed');
    const patch = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const complete = { status: 'complete' as const, format: 'unified', patch, hash: expectedHash };
    return Buffer.byteLength(JSON.stringify(complete)) <= 128 * 1024
        ? complete
        : omitted('model_diff_budget', bytes.length);
}

/** Root authority text is source evidence, not permission to execute repository instructions. */
export async function repositoryInstructionsEvidence(
    source: Pick<FixedSnapshotSource, 'read'>,
    ledger: EvidenceLedger,
    signal?: AbortSignal,
) {
    const request = { side: 'head' as const, path: 'AGENTS.md' };
    try {
        signal?.throwIfAborted();
        const read = await source.read(request, { signal });
        const record = ledger.source(read);
        return {
            status: read.status,
            next: read.next,
            reason: read.reason ?? null,
            evidence: record ? modelEvidence(record) : null,
        };
    } catch (error) {
        if (signal?.aborted || (error instanceof SourceAccessError && error.code === 'cancelled')) throw error;
        return {
            status: 'unavailable' as const,
            next: request,
            reason: 'repository_instructions_unavailable',
            evidence: null,
        };
    }
}

/** Shared original input, never assessor conclusions. Oversize sections remain explicitly readable. */
export function modelPackEvidence(pack: EvidencePack, ledger: EvidenceLedger) {
    const records = contents.get(pack);
    if (!records) throw new Error('pack_invalid');
    const result: {
        status: 'complete' | 'incomplete';
        evidence: ReturnType<typeof modelEvidence>[];
        omitted: Array<{ ref: string; reason: 'model_evidence_budget'; next: PackReadRequest }>;
        unavailable: Array<{ assessmentId: string; reason: 'pinned_publication_unavailable' }>;
    } = { status: 'incomplete', evidence: [], omitted: [], unavailable: [] };
    const candidates: Array<{ record: Evidence; continuation: (typeof result.omitted)[number] }> = [];
    for (const criterion of pack.index.criteria) {
        if (!criterion.available) {
            result.unavailable.push({ assessmentId: criterion.assessmentId, reason: 'pinned_publication_unavailable' });
            continue;
        }
        for (const [section, record] of (records.get(criterion.assessmentId) ?? []).entries()) {
            const continuation: (typeof result.omitted)[number] = {
                ref: record.ref,
                reason: 'model_evidence_budget',
                next: { assessmentId: criterion.assessmentId, section, offset: 0 },
            };
            candidates.push({ record, continuation });
            result.omitted.push(continuation);
        }
    }
    // Reserve every continuation first so a large body cannot crowd out omission metadata.
    let bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > MAX_MODEL_EVIDENCE_BYTES) throw new Error('pack_model_metadata_too_large');
    const included = new Set<(typeof result.omitted)[number]>();
    for (const { record, continuation } of candidates) {
        const view = modelEvidence(record);
        // Conservatively retain array comma overhead; the actual serialized result stays bounded.
        const additional =
            Buffer.byteLength(JSON.stringify(view)) + 1 - Buffer.byteLength(JSON.stringify(continuation));
        if (bytes + additional > MAX_MODEL_EVIDENCE_BYTES) continue;
        bytes += additional;
        ledger.add(record.text, structuredClone(record.provenance));
        result.evidence.push(structuredClone(view));
        included.add(continuation);
    }
    result.omitted = result.omitted.filter((continuation) => !included.has(continuation));
    result.status = result.omitted.length || result.unavailable.length ? 'incomplete' : 'complete';
    return result;
}

/** Original source already read during this run, with cited records first and no inferred conclusions. */
export function modelSourceEvidence(ledger: EvidenceLedger, preferredRefs: string[] = []) {
    const refs = [...new Set([...preferredRefs, ...Object.keys(ledger.records)])];
    const candidates = refs
        .map((ref) => ledger.records[ref])
        .filter((record): record is Evidence => record?.provenance.kind === 'source');
    const result = {
        scope: 'read_fragments' as const,
        status: 'incomplete' as 'complete' | 'incomplete',
        evidence: [] as ReturnType<typeof modelEvidence>[],
        omitted: candidates.map((record) => ({
            ref: record.ref,
            reason: 'model_evidence_budget' as const,
            next: {
                side: record.provenance.side,
                path: record.provenance.path,
                start: record.provenance.start,
            } as ReadRequest,
        })),
    };
    let bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > MAX_MODEL_EVIDENCE_BYTES) throw new Error('pack_model_metadata_too_large');
    const included = new Set<string>();
    for (const [index, record] of candidates.entries()) {
        const view = modelEvidence(record);
        const additional =
            Buffer.byteLength(JSON.stringify(view)) + 1 - Buffer.byteLength(JSON.stringify(result.omitted[index]));
        if (bytes + additional > MAX_MODEL_EVIDENCE_BYTES) continue;
        bytes += additional;
        included.add(record.ref);
        result.evidence.push(structuredClone(view));
    }
    result.omitted = result.omitted.filter((record) => !included.has(record.ref));
    result.status =
        result.omitted.length || candidates.some((record) => record.provenance.readStatus !== 'complete')
            ? 'incomplete'
            : 'complete';
    return result;
}

/** One inspectable pack of the original governed material and prepared comparison metadata. */
export function prepareEvidencePack(options: {
    state: PreparedState;
    publications: Record<string, Publication>;
    ledger: EvidenceLedger;
}): EvidencePack {
    const { state, publications, ledger } = options;
    const records = new Map<string, Evidence[]>();
    const ids = state.entries.map((entry) => entry.assessmentId);
    if (new Set(ids).size !== ids.length) throw new Error('pack_scope_invalid');
    const criteria = state.entries.map((entry): PackCriterion => {
        const material = Object.hasOwn(publications, entry.assessmentId) ? publications[entry.assessmentId] : null;
        const publication = material ? publicationSchema.parse(material) : null;
        if (
            publication &&
            (publication.nodeId !== entry.nodeId ||
                publication.version !== entry.version ||
                publication.subtype !== entry.subtype ||
                digest(publication.content) !== entry.contentHash)
        )
            throw new Error('pack_publication_mismatch');
        const evidence = publication ? ledger.publication(publication) : [];
        records.set(entry.assessmentId, structuredClone(evidence));
        return {
            assessmentId: entry.assessmentId,
            nodeId: entry.nodeId,
            title: publication?.title ?? null,
            version: entry.version,
            subtype: entry.subtype,
            contentHash: entry.contentHash,
            reasons: [...entry.reasons],
            relationships: structuredClone(publication?.relationships ?? []),
            available: !!publication,
            sections: evidence.map((record, index) => ({
                index,
                path: String(record.provenance.path),
                ref: record.ref,
                characters: record.text.length,
                bytes: Buffer.byteLength(record.text),
            })),
        };
    });
    const pack: EvidencePack = {
        index: {
            contractVersion: 1,
            runId: state.runId,
            scopeIdentity: state.scopeIdentity,
            preparationStatus: state.preparationStatus,
            expectedContextCount: state.expectedContextCount,
            comparison: { base: state.artifact.base.commit, head: state.artifact.head.commit },
            criteria,
            changedFiles: structuredClone(state.changes ?? null),
            assets: { diff: 'diff.patch', preparation: 'preparation.md', publications: 'publications.json' },
            gaps: structuredClone(state.gaps),
            limitations: [...state.limitations],
        },
        markdown: '',
    };
    const lines = [
        '# Governed review evidence',
        '',
        `Fixed comparison: ${state.artifact.base.commit} → ${state.artifact.head.commit}.`,
        `Run: ${state.runId}. Scope: ${state.scopeIdentity ?? 'unavailable'}.`,
        '',
        'This is pinned review input, not an assessment or proof of complete coverage.',
        'Original context bodies are below. Required relationships and selection reasons are retained in the index.',
        'Numbered segments belong to their displayed evidence reference, not repository line numbers.',
        '',
        '- [Complete permitted changed-file inventory and governed index](evidence-index.json)',
        '- [Prepared unified diff](diff.patch)',
        '- [Preparation details and exclusions](preparation.md)',
        '- [Original pinned publication objects](publications.json)',
        '',
    ];
    for (const criterion of criteria) {
        lines.push(`## ${criterion.nodeId} @ ${criterion.version ?? 'unavailable'}`, '');
        lines.push(`Assessment: ${criterion.assessmentId}. Subtype: ${criterion.subtype ?? 'unavailable'}.`, '');
        if (!criterion.available) lines.push('Pinned publication unavailable; this criterion remains in scope.', '');
        for (const record of records.get(criterion.assessmentId) ?? []) {
            lines.push(`### ${String(record.provenance.path)}`, '', `Evidence: ${record.ref}`, '');
            for (const segment of modelEvidence(record).segments) lines.push(`[${segment.index}] ${segment.text}`);
            lines.push('');
        }
    }
    pack.markdown = lines.join('\n');
    contents.set(pack, records);
    return pack;
}

/** Artifact filenames are package-owned. The caller owns the trusted run directory and manifest. */
export async function writeEvidencePack(directory: string, pack: EvidencePack) {
    if (!contents.has(pack)) throw new Error('pack_invalid');
    const bodies = {
        'evidence.md': pack.markdown,
        'evidence-index.json': JSON.stringify(pack.index, null, 2) + '\n',
    };
    if (Object.values(bodies).some((body) => Buffer.byteLength(body) > MAX_ARTIFACT_BYTES))
        throw new Error('pack_artifact_too_large');
    const files: Record<string, string> = {};
    for (const [name, body] of Object.entries(bodies)) {
        const path = join(directory, name),
            temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
        files[name] = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    }
    return { files, indexHash: digest(pack.index) };
}

function publicationReadLimits(limits: { maxBytes?: number; maxSegments?: number }) {
    const maxBytes = limits.maxBytes ?? MAX_READ_BYTES,
        maxSegments = limits.maxSegments ?? MAX_READ_SEGMENTS;
    if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 4 ||
        maxBytes > MAX_READ_BYTES ||
        !Number.isSafeInteger(maxSegments) ||
        maxSegments < 1 ||
        maxSegments > MAX_READ_SEGMENTS
    )
        throw new Error('pack_read_limits_invalid');
    return { maxBytes, maxSegments };
}
function readPublicationSections(
    publication: NonNullable<PackReadResult['publication']>,
    fields: Evidence[],
    request: PackReadRequest,
    ledger: EvidenceLedger,
    maxBytes: number,
    maxSegments: number,
): PackReadResult {
    let section = request.section ?? 0,
        offset = request.offset ?? 0;
    const evidence: PackReadResult['evidence'] = [],
        sections: PackReadResult['sections'] = [];
    let remainingBytes = maxBytes,
        remainingSegments = maxSegments;
    while (section < fields.length && remainingBytes >= 4 && remainingSegments > 0) {
        const record = fields[section]!,
            start = offset;
        const end = boundedEnd(record.text, start, remainingBytes, remainingSegments);
        if (end === start) {
            section++;
            offset = 0;
            continue;
        }
        const text = record.text.slice(start, end),
            page =
                start === 0 && end === record.text.length
                    ? ledger.add(record.text, record.provenance)
                    : ledger.add(text, {
                          ...record.provenance,
                          contentStart: start,
                          contentEnd: end,
                          contentLength: record.text.length,
                      });
        const view = modelEvidence(page);
        evidence.push(view);
        sections.push({
            index: section,
            path: String(record.provenance.path),
            offset: start,
            end,
            totalCharacters: record.text.length,
        });
        remainingBytes -= Buffer.byteLength(text);
        remainingSegments -= view.segments.length;
        if (end < record.text.length) {
            offset = end;
            break;
        }
        section++;
        offset = 0;
    }
    const next = section < fields.length ? { assessmentId: request.assessmentId, section, offset } : null;
    return { status: next ? 'truncated' : 'complete', publication, sections, evidence, next };
}

/** Bounded original-material reads. Continuations preserve Unicode and explicit publication offsets. */
export function readPackPublication(
    pack: EvidencePack,
    ledger: EvidenceLedger,
    input: unknown,
    limits: { maxBytes?: number; maxSegments?: number } = {},
): PackReadResult {
    const records = contents.get(pack);
    if (!records) throw new Error('pack_invalid');
    const unavailable = (reason: string): PackReadResult => ({
        status: 'unavailable',
        publication: null,
        sections: [],
        evidence: [],
        next: null,
        reason,
    });
    const parsed = packReadSchema.safeParse(input);
    if (!parsed.success) return unavailable('pack_read_invalid');
    const request = parsed.data,
        criterion = pack.index.criteria.find((entry) => entry.assessmentId === request.assessmentId);
    if (!criterion) return unavailable('pack_publication_unknown');
    const { sections: _sections, ...publication } = criterion;
    if (!criterion.available) return { ...unavailable('pinned_publication_unavailable'), publication };
    const fields = records.get(request.assessmentId)!;
    const section = request.section ?? 0,
        offset = request.offset ?? 0;
    const { maxBytes, maxSegments } = publicationReadLimits(limits);
    if (!fields.length && section === 0 && offset === 0)
        return { status: 'complete', publication, sections: [], evidence: [], next: null };
    if (
        section >= fields.length ||
        offset > fields[section]!.text.length ||
        splitsSurrogate(fields[section]!.text, offset)
    )
        return { ...unavailable('pack_range_invalid'), publication };
    return readPublicationSections(publication, fields, request, ledger, maxBytes, maxSegments);
}

function splitsSurrogate(text: string, offset: number) {
    return (
        offset > 0 &&
        text.charCodeAt(offset) >= 0xdc00 &&
        text.charCodeAt(offset) <= 0xdfff &&
        text.charCodeAt(offset - 1) >= 0xd800 &&
        text.charCodeAt(offset - 1) <= 0xdbff
    );
}
function boundedEnd(text: string, start: number, maxBytes: number, maxSegments: number) {
    let end = start,
        bytes = 0,
        segments = 0;
    while (end < text.length && segments < maxSegments) {
        const point = text.codePointAt(end)!,
            crlf = point === 13 && text.charCodeAt(end + 1) === 10,
            size = crlf ? 2 : point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += crlf || point > 0xffff ? 2 : 1;
        if (point === 10 || point === 13) segments++;
    }
    return end;
}
