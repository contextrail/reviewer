import { z } from 'zod';
import { digest, type GitIdentity } from './prepare.js';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const snapshot = z.strictObject({ commit: objectId, tree: objectId });
const identity = z.strictObject({ base: snapshot, head: snapshot });
const reference = z.strictObject({ ref: z.string().min(1), hash });
/** Phase records are operational review artifacts, never generic event payloads. */
export const phaseRecordSchema = z.strictObject({
    contractVersion: z.literal(1),
    runId: z.string().uuid(),
    phase: z.enum(['prepare', 'plan', 'assess', 'verify', 'finalize']),
    workUnitId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
    attempt: z.number().int().positive(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    status: z.enum(['complete', 'incomplete', 'failed', 'cancelled']),
    inputRefs: z.array(reference),
    outputHash: hash,
    artifact: identity,
    scopeIdentity: hash.nullable(),
    assessmentIds: z.array(z.string().min(1)),
    evidenceRefs: z.array(z.string().min(1)),
    limitations: z.array(z.string()),
    stopReason: z.string().nullable(),
    configuration: z.record(z.string(), z.unknown()),
    usageRefs: z.array(z.string()),
    output: z.unknown(),
});
export type PhaseRecord = z.infer<typeof phaseRecordSchema>;
export type PhaseIdentity = {
    runId: string;
    artifact: GitIdentity;
    scopeIdentity: string | null;
    assessmentIds: string[];
    inputRefs?: PhaseRecord['inputRefs'];
    phase?: PhaseRecord['phase'];
    workUnitId?: string;
    attempt?: number;
    requireComplete?: boolean;
};
const fixedIdentity = (artifact: GitIdentity) => ({
    base: { commit: artifact.base.commit, tree: artifact.base.tree },
    head: { commit: artifact.head.commit, tree: artifact.head.tree },
});
/** Build an immutable handoff; callers then validate their phase-specific output schema. */
export function createPhaseRecord(
    input: Omit<PhaseRecord, 'contractVersion' | 'outputHash' | 'artifact'> & { artifact: GitIdentity },
): PhaseRecord {
    return phaseRecordSchema.parse({
        ...input,
        contractVersion: 1,
        artifact: fixedIdentity(input.artifact),
        outputHash: digest(input.output),
    });
}
/** Hashes establish integrity/identity, not authority or semantic correctness. */
export function validatePhaseRecord(value: unknown, expected: PhaseIdentity): PhaseRecord {
    const record = phaseRecordSchema.parse(value);
    const sameSet = (left: string[], right: string[]) =>
        new Set(left).size === left.length &&
        new Set(right).size === right.length &&
        left.length === right.length &&
        left.every((id) => right.includes(id));
    const matchesSelection = (['phase', 'workUnitId', 'attempt'] as const).every(
        (key) => expected[key] === undefined || record[key] === expected[key],
    );
    if (
        record.runId !== expected.runId ||
        !matchesSelection ||
        (expected.requireComplete !== false && record.status !== 'complete') ||
        record.scopeIdentity !== expected.scopeIdentity ||
        digest(record.artifact) !== digest(fixedIdentity(expected.artifact)) ||
        record.outputHash !== digest(record.output) ||
        !sameSet(record.assessmentIds, expected.assessmentIds) ||
        (expected.inputRefs !== undefined && digest(record.inputRefs) !== digest(expected.inputRefs)) ||
        new Set(record.inputRefs.map((item) => item.ref)).size !== record.inputRefs.length ||
        Date.parse(record.finishedAt) < Date.parse(record.startedAt)
    )
        throw new Error('invalid_phase_handoff');
    return record;
}
