import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { publicationSchema } from './contracts.js';
import { EvidenceLedger, type Evidence } from './evidence.js';
import { validatePublicationArtifacts } from './github.js';
import { digest, preparationManifest, type GitIdentity, type PreparedState } from './prepare.js';
import type { ReviewState } from './review.js';

export type ReviewCheckpoint = {
    state: ReviewState;
    evidence: Record<string, Evidence>;
    preparationManifest: Record<string, unknown>;
};

function readObject(path: string): Record<string, unknown> {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
        throw new Error('resume_artifact_invalid');
    return z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, 'utf8')));
}

function validateResumeIdentity(raw: Record<string, unknown>, expected: { artifact: GitIdentity; reviewerId: string }) {
    if (
        raw.schemaVersion !== 2 ||
        raw.reviewStatus !== 'incomplete' ||
        raw.preparationStatus !== 'prepared' ||
        raw.requestedReviewerId !== expected.reviewerId
    )
        throw new Error('resume_requires_incomplete_prepared_run');
    const artifact = z
        .object({
            repository: z.string(),
            base: z.object({ commit: z.string(), tree: z.string() }),
            head: z.object({ commit: z.string(), tree: z.string() }),
        })
        .parse(raw.artifact);
    if (
        realpathSync(artifact.repository) !== realpathSync(expected.artifact.repository) ||
        (['base', 'head'] as const).some(
            (side) =>
                artifact[side].commit !== expected.artifact[side].commit ||
                artifact[side].tree !== expected.artifact[side].tree,
        )
    )
        throw new Error('resume_comparison_changed');
}

function validatePinnedPreparation(
    state: ReviewState,
    manifest: Record<string, unknown>,
    publications: Record<string, unknown>,
) {
    if (
        !Array.isArray(state.entries) ||
        digest(state.entries.map(({ result: _result, ...entry }) => entry)) !== digest(manifest.entries) ||
        digest(state.diff ?? null) !== manifest.diffHash ||
        digest(state.changes) !== manifest.changesHash ||
        digest(state.reviewer) !== digest(manifest.reviewer)
    )
        throw new Error('resume_preparation_changed');
    for (const entry of state.entries) {
        const publication = publicationSchema.parse(publications[entry.assessmentId]);
        if (
            publication.nodeId !== entry.nodeId ||
            publication.version !== entry.version ||
            digest(publication.content) !== entry.contentHash
        )
            throw new Error('resume_publication_identity_changed');
    }
}

function restoreCheckpointEvidence(evidence: Record<string, unknown>) {
    const ledger = new EvidenceLedger();
    for (const [ref, value] of Object.entries(evidence)) {
        const record = z
            .object({
                ref: z.string(),
                text: z.string(),
                provenance: z.record(z.string(), z.unknown()),
                fragments: z
                    .array(
                        z.object({
                            line: z.number().int().positive(),
                            column: z.number().int().nonnegative(),
                            text: z.string(),
                        }),
                    )
                    .optional(),
            })
            .parse(value);
        if (record.ref !== ref || ledger.add(record.text, record.provenance, record.fragments).ref !== ref)
            throw new Error('resume_evidence_changed');
    }
    return ledger.records;
}

/** Resume only sealed incomplete runs. An interrupted unsealed write is not a trusted checkpoint. */
export function loadReviewCheckpoint(runDirectory: string, expected: { artifact: GitIdentity; reviewerId: string }) {
    const directory = realpathSync(resolve(runDirectory));
    const statePath = join(directory, 'state.json');
    const raw = readObject(statePath);
    validateResumeIdentity(raw, expected);
    validatePublicationArtifacts(directory, raw, statePath);
    const manifest = readObject(join(directory, 'manifest.json'));
    const files = z.record(z.string(), z.string()).parse(manifest.files);
    if (['state.json', 'publications.json', 'evidence.json'].some((name) => !Object.hasOwn(files, name)))
        throw new Error('resume_checkpoint_unbound');
    const materialPath = join(directory, 'publications.json');
    const publications = readObject(materialPath);
    if (manifest.publicationsHash !== digest(publications)) throw new Error('resume_publications_changed');
    const state = raw as unknown as ReviewState;
    validatePinnedPreparation(state, manifest, publications);
    const evidence = readObject(join(directory, 'evidence.json'));
    const records = restoreCheckpointEvidence(evidence);
    const preparedState: PreparedState = {
        schemaVersion: 1,
        runId: state.runId,
        createdAt: state.createdAt,
        preparationStatus: state.preparationStatus,
        reviewStatus: 'not_started',
        artifact: state.artifact,
        reviewer: state.reviewer,
        requestedReviewerId: state.requestedReviewerId,
        scopeIdentity: state.scopeIdentity,
        expectedContextCount: state.expectedContextCount,
        entries: state.entries.map(({ result: _result, ...entry }) => ({
            ...entry,
            result: { disposition: 'not_evaluated', adherence: null, confidence: null },
        })),
        gaps: state.gaps,
        limitations: state.limitations,
        diff: state.diff,
        changes: state.changes,
    };
    return {
        prepared: { state: preparedState, statePath, materialPath, manifestPath: join(directory, 'manifest.json') },
        checkpoint: {
            state,
            evidence: records,
            preparationManifest: preparationManifest(manifest),
        } satisfies ReviewCheckpoint,
    };
}
