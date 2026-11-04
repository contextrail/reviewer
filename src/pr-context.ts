import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import type { GitIdentity } from './prepare.js';

const MAX_PR_CONTEXT_BYTES = 200 * 1024;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const text = (max: number) => z.string().max(max);
const disposition = z.enum(['evaluated', 'unresolved', 'not_applicable', 'not_evaluated']);
const finding = z.enum(['none', 'binding_violation', 'behavioral_defect', 'guidance_departure']);
const entry = z.strictObject({
    nodeId: text(500).startsWith('context://'),
    version: z.number().int().positive(),
    disposition,
    finding,
    explanation: text(300),
    correction: text(200),
});
const run = z.strictObject({
    provider: z.enum(['openai', 'openrouter', 'unknown']),
    model: text(200),
    effort: text(20),
    cliRunId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,200}$/)
        .nullable(),
    id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    attempt: z.number().int().positive().max(1000000),
    base: sha.nullable(),
    head: sha.nullable(),
    at: z.iso.datetime(),
    assessment: z.enum(['complete', 'incomplete', 'running', 'not_started', 'unknown']),
    execution: z.enum(['finished', 'failed', 'unknown']),
    exit: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable(),
    findings: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().nullable(),
    cost: z.number().nonnegative().nullable(),
    costComplete: z.boolean(),
    packageVersion: text(100),
    reviewerVersion: z.number().nonnegative().nullable(),
});
const contextFields = {
    repository: text(301).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pr: z.number().int().positive(),
    reviewer: text(500).startsWith('skill://'),
    capturedAt: z.iso.datetime(),
    comparison: z.strictObject({ base: sha, head: sha }),
    history: z.strictObject({
        status: z.enum(['available', 'unavailable']),
        runs: z.array(run).max(10),
        omitted: z.number().int().nonnegative(),
        assessment: z
            .strictObject({
                base: sha,
                head: sha,
                cliRunId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
                run: z.string().regex(/^[1-9][0-9]{0,19}$/),
                attempt: z.number().int().positive(),
                reviewerVersion: z.number().nonnegative().nullable(),
                scopeIdentity: text(150),
                provider: z.enum(['openai', 'openrouter', 'unknown']),
                model: text(200),
                effort: text(20),
                entries: z.array(entry).max(30),
                omitted: z.number().int().nonnegative(),
            })
            .nullable(),
    }),
    discussion: z.strictObject({
        status: z.enum(['available', 'partial', 'unavailable']),
        items: z
            .array(
                z.strictObject({
                    kind: z.enum(['comment', 'review', 'thread', 'dismissal']),
                    id: text(200),
                    author: text(100),
                    association: text(100),
                    body: text(1000),
                    url: text(1000).startsWith('https://github.com/'),
                    at: text(50),
                    state: text(50),
                    resolved: z.boolean().nullable(),
                    outdated: z.boolean().nullable(),
                    resolvedBy: text(100),
                    path: text(500),
                    line: z.number().int().positive().nullable(),
                }),
            )
            .max(80),
    }),
    changesSincePrevious: z.strictObject({
        status: z.enum(['available', 'partial', 'unavailable', 'same_head']),
        base: sha.nullable(),
        head: sha,
        relation: text(50),
        files: z.array(z.strictObject({ path: text(500), status: text(50) })).max(100),
    }),
    limitations: z.array(text(300)).max(12),
};
const phaseModel = z.strictObject({
    phase: z.enum(['plan', 'assess', 'verify']),
    provider: z.enum(['openai', 'openrouter']),
    model: text(200),
    effort: text(20).optional(),
});
const v1 = z.strictObject({ version: z.literal(1), ...contextFields });
const observationStatus = z.enum(['available', 'partial', 'unavailable']);
const observedChecks = z.strictObject({
    source: z.literal('github_api'),
    head: sha,
    capturedAt: z.iso.datetime(),
    checkRuns: z.strictObject({
        status: observationStatus,
        items: z
            .array(
                z.strictObject({
                    name: text(200),
                    status: text(50),
                    conclusion: text(50).nullable(),
                }),
            )
            .max(50),
    }),
    commitStatuses: z.strictObject({
        status: observationStatus,
        items: z.array(z.strictObject({ context: text(200), state: text(50) })).max(50),
    }),
});
const v2 = z.strictObject({
    version: z.literal(2),
    ...contextFields,
    observedChecks: observedChecks.optional(),
    intent: z.strictObject({
        title: text(1000),
        body: text(20000),
        source: z.enum(['github_pull_request', 'caller']),
    }),
    history: contextFields.history.extend({
        runs: z.array(run.extend({ phaseModels: z.array(phaseModel).max(3).optional() })).max(10),
    }),
});
export const prContextSchema = z.discriminatedUnion('version', [v1, v2]);
export type PrContext = z.infer<typeof prContextSchema>;
/** This binds advisory data to the current comparison; parsing does not authenticate its claims. */
export function parsePrContext(value: unknown, artifact: GitIdentity, reviewer: string): PrContext {
    try {
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_PR_CONTEXT_BYTES) throw new Error();
        const context = prContextSchema.parse(value);
        if (
            context.comparison.base !== artifact.base.commit ||
            context.comparison.head !== artifact.head.commit ||
            context.reviewer !== reviewer ||
            (context.version === 2 &&
                context.observedChecks !== undefined &&
                context.observedChecks.head !== context.comparison.head)
        )
            throw new Error();
        for (const item of context.discussion.items) {
            const url = new URL(item.url);
            if (
                url.search ||
                ![`/${context.repository}/pull/${context.pr}`, `/${context.repository}/issues/${context.pr}`].includes(
                    url.pathname,
                )
            )
                throw new Error();
        }
        const repository = artifact.repositoryEnvironment;
        if (
            repository.status === 'reported' &&
            (repository.provider !== 'github.com' ||
                context.repository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase())
        )
            throw new Error();
        if (
            repository.status !== 'reported' &&
            !context.limitations.includes(
                'Repository origin unavailable; PR identity is reported, not independently bound.',
            )
        )
            context.limitations = [
                ...context.limitations.slice(0, 11),
                'Repository origin unavailable; PR identity is reported, not independently bound.',
            ];
        return context;
    } catch {
        throw new Error('invalid_pr_context');
    }
}
export function loadPrContext(file: string, artifact: GitIdentity, reviewer: string): PrContext {
    let fd: number | undefined;
    try {
        fd = openSync(file, 'r');
        if (!fstatSync(fd).isFile()) throw new Error();
        const buffer = Buffer.alloc(MAX_PR_CONTEXT_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
            const count = readSync(fd, buffer, size, buffer.length - size, null);
            if (!count) break;
            size += count;
        }
        if (size > MAX_PR_CONTEXT_BYTES) throw new Error();
        return parsePrContext(JSON.parse(buffer.subarray(0, size).toString('utf8')), artifact, reviewer);
    } catch {
        throw new Error('invalid_pr_context');
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}
