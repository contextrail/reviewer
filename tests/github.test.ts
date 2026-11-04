import { createHash, randomUUID } from 'node:crypto';
import { digest, prepareReview } from '../src/prepare.js';
import { runReview } from '../src/review.js';
import type { Publication, PublishedReader } from '../src/contracts.js';
import { createPhaseRecord } from '../src/phases.js';
import { reconcileFindings, type ReviewFinding } from '../src/assessment.js';
import { groupDeveloperFindings, markdownText } from '../src/presentation.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildInlineReview,
    parseDiffAnchors,
    githubRequester,
    publishGitHubReview,
    validatePublicationArtifacts,
    findReviewComment,
} from '../src/github.js';
const base = 'a'.repeat(40),
    head = 'b'.repeat(40),
    blob = 'c'.repeat(40),
    reviewer = 'skill://engineering/review';
const diff =
    'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+bad\n';
const citation = {
    ref: 'source-ref',
    quote: 'bad',
    provenance: { kind: 'source', side: 'head', commit: head, path: 'new.ts', object: blob },
    location: { line: 2, column: 0 },
};
const finding = {
    findingId: 'finding',
    assessmentIds: ['criterion'],
    checkIds: ['check'],
    classification: 'binding_violation',
    locationRefs: [citation],
    explanation: 'Changed behavior violates the selected rule.',
    consequence: 'Incorrect value.',
    correction: 'Use good.',
    limitations: [],
    verified: true,
    proposedReplacement: {
        path: 'new.ts',
        blob,
        startLine: 2,
        endLine: 2,
        before: 'bad',
        replacement: 'good',
        verified: true,
    },
};
const state = {
    artifact: { head: { commit: head } },
    runId: 'run',
    reviewer: { nodeId: reviewer },
    entries: [{ assessmentId: 'criterion', nodeId: 'context://engineering/rule', version: 1 }],
    findings: [finding],
};
const source = () => ({ blob, text: 'keep\nbad\n' });
const roots: string[] = [];
afterEach(() => {
    vi.unstubAllEnvs();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function seal(root: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const report = { ...state, schemaVersion: 2, scopeIdentity: state.scopeIdentity ?? null };
    writeFileSync(join(root, 'report.json'), JSON.stringify(report));
    const manifest = {
        contractVersion: 1,
        runId: report.runId,
        artifact: report.artifact,
        scopeIdentity: report.scopeIdentity,
        entries: report.entries ?? [],
        ...extra,
    };
    const files = Object.fromEntries(
        ['report.json', ...Object.keys(extra.files ?? {})].map((name) => [
            name,
            'sha256:' +
                createHash('sha256')
                    .update(readFileSync(join(root, name)))
                    .digest('hex'),
        ]),
    );
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, files }));
}
describe('inline governed feedback', () => {
    it('maps renamed old/new diff sides without inventing unchanged file anchors', () => {
        const a = parseDiffAnchors(diff);
        expect(a.get('new.ts\0RIGHT')?.has(2)).toBe(true);
        expect(a.get('old.ts\0LEFT')?.has(2)).toBe(true);
        expect(a.has('unrelated.ts\0RIGHT')).toBe(false);
    });
    it('publishes verified source-matching corrections as GitHub suggestions', () => {
        const r = buildInlineReview(state, {}, { diff, source });
        expect(r.comments).toHaveLength(1);
        expect(r.comments[0]).toMatchObject({ path: 'new.ts', side: 'RIGHT', line: 2 });
        expect(r.comments[0]!.body).toContain('```suggestion\ngood\n```');
    });
    it('keeps unverified and malformed suggestions out while preserving a valid finding', () => {
        for (const replacement of [
            { ...finding.proposedReplacement, verified: false },
            { ...finding.proposedReplacement, before: 'stale' },
            { ...finding.proposedReplacement, replacement: '```evil' },
            { ...finding.proposedReplacement, blob: 'd'.repeat(40) },
        ]) {
            const r = buildInlineReview(
                { ...state, findings: [{ ...finding, proposedReplacement: replacement }] },
                {},
                { diff, source },
            );
            expect(r.comments).toHaveLength(1);
            expect(r.comments[0]!.body).not.toContain('```suggestion');
        }
    });
    it('rejects unverified findings, unknown anchors and mismatched source blobs', () => {
        for (const f of [
            { ...finding, verified: false },
            { ...finding, locationRefs: [{ ...citation, location: { line: 99, column: 0 } }] },
            {
                ...finding,
                locationRefs: [{ ...citation, provenance: { ...citation.provenance, object: 'd'.repeat(40) } }],
            },
        ])
            expect(buildInlineReview({ ...state, findings: [f] }, {}, { diff, source })).toMatchObject({
                comments: [],
                omitted: 1,
            });
    });
    it('deduplicates existing bot threads while ignoring a human-spoofed marker', () => {
        const initial = buildInlineReview(state, {}, { diff, source }).comments[0]!;
        expect(
            buildInlineReview(
                state,
                {},
                {
                    diff,
                    source,
                    existingComments: [{ body: initial.body, user: { login: 'github-actions[bot]', type: 'Bot' } }],
                },
            ),
        ).toMatchObject({ comments: [], duplicates: 1 });
        expect(
            buildInlineReview(
                state,
                {},
                { diff, source, existingComments: [{ body: initial.body, user: { login: 'attacker', type: 'User' } }] },
            ).comments,
        ).toHaveLength(1);
    });
    it('falls back to the main report for deleted-side corrections', () => {
        const left = {
            ...citation,
            quote: 'old',
            provenance: { ...citation.provenance, side: 'base', path: 'old.ts' },
        };
        const r = buildInlineReview(
            { ...state, findings: [{ ...finding, locationRefs: [left] }] },
            {},
            { diff, source: () => ({ blob, text: 'keep\nold\n' }) },
        );
        expect(r.comments[0]?.side).toBe('LEFT');
        expect(r.comments[0]?.body).not.toContain('```suggestion');
    });
    it('does not offer a new suggestion overlapping a marked current-head bot suggestion', () => {
        const original = buildInlineReview(state, {}, { diff, source }).comments[0]!;
        const next = { ...state, entries: [{ ...state.entries[0], version: 2 }] };
        const existing = {
            body: original.body,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            commit_id: head,
            path: 'new.ts',
            side: 'RIGHT',
            line: 2,
        };
        const result = buildInlineReview(next, {}, { diff, source, existingComments: [existing] });
        expect(result.comments).toHaveLength(1);
        expect(result.comments[0]!.body).not.toContain('```suggestion');
        const outdated = buildInlineReview(
            next,
            {},
            { diff, source, existingComments: [{ ...existing, commit_id: base }] },
        );
        expect(outdated.comments[0]!.body).toContain('```suggestion');
    });
    it('groups distinct verified accounts at the same exact range without erasing either account', () => {
        const second = {
            ...finding,
            findingId: 'second',
            checkIds: ['different-check'],
            explanation: 'A distinct supported issue.',
        };
        const result = buildInlineReview({ ...state, findings: [finding, second] }, {}, { diff, source });
        expect(result.comments).toHaveLength(1);
        expect(result.duplicates).toBe(0);
        expect(result.comments[0]!.body).toContain(markdownText(finding.explanation));
        expect(result.comments[0]!.body).toContain('distinct supported issue');
        expect(result.comments[0]!.body).toContain('```suggestion');
    });
    it('preserves all criteria and mixed classifications while deduplicating grouped and legacy threads', () => {
        const second = {
            ...finding,
            findingId: 'second-account',
            assessmentIds: ['second-criterion'],
            checkIds: ['second-check'],
            classification: 'behavioral_defect',
            explanation: 'A distinct account under another governing criterion.',
        };
        const input = {
            ...state,
            entries: [
                ...state.entries,
                { assessmentId: 'second-criterion', nodeId: 'context://engineering/second', version: 1 },
            ],
            findings: [finding, second],
        };
        const before = JSON.stringify(input);
        const grouped = buildInlineReview(input, {}, { diff, source });
        expect(grouped.comments).toHaveLength(1);
        const comment = grouped.comments[0]!;
        expect(comment.body).toContain('engineering/rule');
        expect(comment.body).toContain('engineering/second');
        expect(comment.body).toContain('binding\\_violation');
        expect(comment.body).toContain('behavioral\\_defect');
        expect(comment.body).toContain(markdownText(second.explanation));
        const botComment = (body: string) => ({ body, user: { login: 'github-actions[bot]', type: 'Bot' } });
        const reversed = { ...input, findings: [second, finding] };
        expect(
            buildInlineReview(reversed, {}, { diff, source, existingComments: [botComment(comment.body)] }),
        ).toMatchObject({ comments: [], duplicates: 1 });
        const oldA = buildInlineReview({ ...input, findings: [finding] }, {}, { diff, source }).comments[0]!;
        const oldB = buildInlineReview({ ...input, findings: [second] }, {}, { diff, source }).comments[0]!;
        const partial = buildInlineReview(input, {}, { diff, source, existingComments: [botComment(oldA.body)] });
        expect(partial.comments).toHaveLength(1);
        expect(partial.comments[0]!.body).toContain(markdownText(second.explanation));
        expect(
            buildInlineReview(
                input,
                {},
                { diff, source, existingComments: [botComment(oldA.body), botComment(oldB.body)] },
            ),
        ).toMatchObject({ comments: [], duplicates: 1 });
        expect(JSON.stringify(input)).toBe(before);
    });
    it('does not combine distinct ranges or offer conflicting grouped corrections', () => {
        const distinct = {
            ...finding,
            findingId: 'other-range',
            proposedReplacement: undefined,
            locationRefs: [{ ...citation, quote: 'keep', location: { line: 1, column: 0 } }],
        };
        expect(
            buildInlineReview({ ...state, findings: [finding, distinct] }, {}, { diff, source }).comments,
        ).toHaveLength(2);
        for (const patch of [
            { ...finding.proposedReplacement, replacement: 'a different correction' },
            { ...finding.proposedReplacement, verified: false },
        ]) {
            const second = {
                ...finding,
                findingId: 'conflicting-account',
                explanation: 'Another supported account.',
                proposedReplacement: patch,
            };
            const result = buildInlineReview({ ...state, findings: [finding, second] }, {}, { diff, source });
            expect(result.comments).toHaveLength(1);
            expect(result.comments[0]!.body).toContain(markdownText(second.explanation));
            expect(result.comments[0]!.body).not.toContain('```suggestion');
        }
    });
    it('posts nested overlapping spans in one thread while retaining every criterion and its own location', () => {
        const text = 'before\nouter head\ninner one\ninner two\nouter tail\nafter\n';
        const patch = `diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,6 @@\n${text
            .split('\n')
            .slice(0, -1)
            .map((line) => `+${line}\n`)
            .join('')}`;
        const accounts = Array.from({ length: 4 }, (_, index) => ({
            ...finding,
            findingId: `overlap-account-${index}`,
            assessmentIds: [`overlap-criterion-${index}`],
            checkIds: [`overlap-check-${index}`],
            explanation: `Supported account ${index}`,
            proposedReplacement: undefined,
            locationRefs: [
                {
                    ...citation,
                    ref: `overlap-ref-${index}`,
                    quote:
                        index === 0
                            ? 'outer head\ninner one\ninner two\nouter tail\n'
                            : 'inner one\ninner two\nouter tail\n',
                    location: { line: index === 0 ? 2 : 3, column: 0 },
                },
            ],
        }));
        const input = {
            ...state,
            findings: accounts,
            entries: accounts.map((account, index) => ({
                assessmentId: account.assessmentIds[0]!,
                nodeId: `context://engineering/overlap-${index}`,
                version: 1,
            })),
        };
        const before = JSON.stringify(input);
        const result = buildInlineReview(input, {}, { diff: patch, source: () => ({ blob, text }) });
        expect(result.comments).toHaveLength(1);
        const body = result.comments[0]!.body;
        expect(body).toContain('4 verified accounts at overlapping source ranges');
        for (const [index, account] of accounts.entries()) {
            expect(body).toContain(markdownText(account.explanation));
            expect(body).toContain(markdownText(account.findingId));
            expect(body).toContain(`engineering/overlap-${index}`);
            expect(body).toContain(markdownText(`new.ts:${index === 0 ? 2 : 3}:0–6:0`));
        }
        expect(result.omitted).toBe(0);
        const postedAccounts = accounts.map((account) => ({
            body: buildInlineReview(
                { ...input, findings: [account] },
                {},
                { diff: patch, source: () => ({ blob, text }) },
            ).comments[0]!.body,
            user: { login: 'github-actions[bot]', type: 'Bot' },
        }));
        expect(
            buildInlineReview(
                input,
                {},
                { diff: patch, source: () => ({ blob, text }), existingComments: postedAccounts },
            ),
        ).toMatchObject({ comments: [], duplicates: 1 });
        const partlyPosted = buildInlineReview(
            input,
            {},
            { diff: patch, source: () => ({ blob, text }), existingComments: postedAccounts.slice(0, 1) },
        );
        expect(partlyPosted.comments).toHaveLength(1);
        expect(partlyPosted.comments[0]!.body).toContain('engineering/overlap-3');
        expect(
            buildInlineReview(
                { ...input, findings: [...accounts].reverse() },
                {},
                {
                    diff: patch,
                    source: () => ({ blob, text }),
                    existingComments: [{ body, user: { login: 'github-actions[bot]', type: 'Bot' } }],
                },
            ),
        ).toMatchObject({ comments: [], duplicates: 1 });
        const fabricated = accounts.map((account, index) =>
            index === 2
                ? {
                      ...account,
                      locationRefs: [
                          { ...account.locationRefs[0]!, quote: 'inner one\nUNOBSERVED_LINE\nouter tail\n' },
                      ],
                  }
                : account,
        );
        expect(
            buildInlineReview({ ...input, findings: fabricated }, {}, { diff: patch, source: () => ({ blob, text }) }),
        ).toMatchObject({ comments: [], omitted: 4 });
        expect(JSON.stringify(input)).toBe(before);
    });
    it('keeps disjoint columns, adjacent spans and different pinned source identities separate', () => {
        const text = 'abcdef\nnext\n';
        const patch = 'diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+abcdef\n+next\n';
        const first = {
            ...finding,
            findingId: 'column-first',
            proposedReplacement: undefined,
            locationRefs: [{ ...citation, quote: 'ab', location: { line: 1, column: 0 } }],
        };
        for (const location of [
            { quote: 'ef', line: 1, column: 4 },
            { quote: 'cd', line: 1, column: 2 },
            { quote: 'next\n', line: 2, column: 0 },
        ]) {
            const left =
                location.line === 2
                    ? { ...first, locationRefs: [{ ...first.locationRefs[0]!, quote: 'abcdef\n' }] }
                    : first;
            const second = {
                ...first,
                findingId: 'column-second',
                locationRefs: [
                    { ...citation, quote: location.quote, location: { line: location.line, column: location.column } },
                ],
            };
            expect(
                buildInlineReview(
                    { ...state, findings: [left, second] },
                    {},
                    { diff: patch, source: () => ({ blob, text }) },
                ).comments,
            ).toHaveLength(2);
        }
        for (const identity of [{ object: 'd'.repeat(40) }, { path: 'other.ts' }]) {
            const second = {
                ...first,
                findingId: 'different-source',
                locationRefs: [{ ...first.locationRefs[0]!, provenance: { ...citation.provenance, ...identity } }],
            };
            expect(groupDeveloperFindings([first, second])).toHaveLength(2);
        }
    });
    it('limits new inline batches and records overflow', () => {
        const lines = Array.from({ length: 22 }, (_, i) => `+bad${i}`).join('\n');
        const manyDiff = `diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,22 @@\n${lines}\n`;
        const findings = Array.from({ length: 22 }, (_, i) => ({
            ...finding,
            proposedReplacement: undefined,
            locationRefs: [{ ...citation, location: { line: i + 1, column: 0 } }],
        }));
        const r = buildInlineReview(
            { ...state, findings },
            {},
            {
                diff: manyDiff,
                source: () => ({ blob, text: Array.from({ length: 22 }, (_, i) => `bad${i}`).join('\n') }),
            },
        );
        expect(r.comments).toHaveLength(20);
        expect(r.omitted).toBe(2);
    });
});
describe('GitHub adapter boundaries', () => {
    it('does not leak rejected upstream payloads or retry writes', async () => {
        let calls = 0;
        const fetcher: typeof fetch = async () => {
            calls++;
            return new Response('private upstream secret', { status: 403 });
        };
        await expect(
            githubRequester('acme/project', 'secret', fetcher)('/issues/1/comments', 'POST', { body: 'x' }),
        ).rejects.toThrow('github_write_403');
        expect(calls).toBe(1);
    });
    it('fails closed when history pagination is incomplete', async () => {
        let pages = 0;
        await expect(
            findReviewComment({ repository: 'acme/project', pr: 1, reviewer }, async () => {
                pages++;
                return Array.from({ length: 100 }, () => ({ body: 'unrelated' }));
            }),
        ).rejects.toThrow('github_lookup_incomplete');
        expect(pages).toBe(10);
    });
    it('dry-runs complete comment payloads with no GitHub requests', async () => {
        const root = mkdtempSync(join(tmpdir(), 'review-publish-'));
        roots.push(root);
        const input = {
            version: 1,
            repository: 'acme/project',
            pr: 1,
            reviewer,
            base,
            head,
            baseBranch: 'alpha',
            githubRun: '10',
            githubAttempt: 1,
        };
        writeFileSync(join(root, 'github-input.json'), JSON.stringify(input));
        writeFileSync(
            join(root, 'report.json'),
            JSON.stringify({
                ...state,
                artifact: { base: { commit: base }, head: { commit: head } },
                reviewStatus: 'incomplete',
            }),
        );
        seal(root, {
            ...state,
            findings: [],
            artifact: { base: { commit: base }, head: { commit: head } },
            reviewStatus: 'incomplete',
        });
        const result = await publishGitHubReview({
            runDir: root,
            githubDir: root,
            postComment: true,
            dryRun: true,
            fetch: async () => {
                throw new Error('network forbidden');
            },
        });
        expect(result).toMatchObject({ exitCode: 0, status: 'preview' });
        const tampered = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
        tampered.reviewStatus = 'complete';
        writeFileSync(join(root, 'report.json'), JSON.stringify(tampered));
        await expect(
            publishGitHubReview({
                runDir: root,
                githubDir: root,
                postComment: true,
                token: 'fixture-token',
                fetch: async () => {
                    throw new Error('network must not run');
                },
            }),
        ).rejects.toThrow('publication_artifact_changed');
    });
});

describe('inline publication integration', () => {
    it('creates a comment-only review with exact pinned suggestion payload and preserves the assessment', async () => {
        const root = mkdtempSync(join(tmpdir(), 'review-inline-publish-'));
        roots.push(root);
        const git = (args: string[]) =>
            execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
                cwd: root,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: 'Fixture',
                    GIT_AUTHOR_EMAIL: 'fixture@example.test',
                    GIT_COMMITTER_NAME: 'Fixture',
                    GIT_COMMITTER_EMAIL: 'fixture@example.test',
                },
            }).trim();
        git(['init', '--quiet']);
        writeFileSync(join(root, 'new.ts'), 'keep\ngood\n');
        git(['add', 'new.ts']);
        git(['commit', '--quiet', '-m', 'fixture base']);
        const base = git(['rev-parse', 'HEAD']);
        writeFileSync(join(root, 'new.ts'), 'keep\nbad\n');
        git(['add', 'new.ts']);
        git(['commit', '--quiet', '-m', 'fixture head']);
        const head = git(['rev-parse', 'HEAD']),
            blob = git(['rev-parse', 'HEAD:new.ts']);
        const c = {
            version: 1,
            repository: 'acme/project',
            pr: 1,
            reviewer,
            base,
            head,
            baseBranch: 'alpha',
            githubRun: '100',
            githubAttempt: 1,
        };
        writeFileSync(join(root, 'github-input.json'), JSON.stringify(c));
        const f = {
            ...finding,
            locationRefs: [{ ...citation, provenance: { ...citation.provenance, object: blob, commit: head } }],
            proposedReplacement: { ...finding.proposedReplacement, blob },
        };
        const report = {
            ...state,
            schemaVersion: 2,
            artifact: { repository: root, base: { commit: base }, head: { commit: head } },
            reviewStatus: 'complete',
            decision: { exitCode: 1 },
            findings: [f],
        };
        writeFileSync(join(root, 'report.json'), JSON.stringify(report));
        writeFileSync(join(root, 'evidence.json'), '{}');
        report.runId = randomUUID();
        Object.assign(report.artifact.base, { tree: git(['rev-parse', `${base}^{tree}`]) });
        Object.assign(report.artifact.head, { tree: git(['rev-parse', `${head}^{tree}`]) });
        const scopeIdentity = 'sha256:' + 'e'.repeat(64);
        Object.assign(report, { scopeIdentity });
        const prepared = {
            contractVersion: 1,
            runId: report.runId,
            artifact: report.artifact,
            scopeIdentity,
            entries: report.entries,
        };
        const publications = {};
        writeFileSync(join(root, 'publications.json'), JSON.stringify(publications));
        const now = new Date().toISOString(),
            proposal = {
                result: { assessmentId: 'criterion' },
                findings: [
                    { ...f, verified: false, proposedReplacement: { ...f.proposedReplacement, verified: false } },
                ],
            };
        const common = {
            runId: report.runId,
            workUnitId: 'unit',
            attempt: 1,
            startedAt: now,
            finishedAt: now,
            status: 'complete' as const,
            artifact: report.artifact as never,
            scopeIdentity,
            assessmentIds: ['criterion'],
            evidenceRefs: [],
            limitations: [],
            stopReason: null,
            configuration: {},
            usageRefs: [],
        };
        const refs = [
            { ref: 'manifest.json', hash: digest(prepared) },
            { ref: 'publications.json', hash: digest(publications) },
        ];
        const assess = createPhaseRecord({ ...common, phase: 'assess', inputRefs: refs, output: [proposal] });
        const verify = createPhaseRecord({
            ...common,
            phase: 'verify',
            inputRefs: [...refs, { ref: 'phase:assess:unit:1', hash: digest(assess) }],
            output: [
                {
                    assessmentId: 'criterion',
                    disposition: 'accept',
                    findings: [{ findingId: f.findingId, accepted: true, suggestionAccepted: true }],
                },
            ],
        });
        mkdirSync(join(root, 'phases'));
        writeFileSync(join(root, 'phases/assess-unit-1.json'), JSON.stringify(assess));
        writeFileSync(join(root, 'phases/verify-unit-1.json'), JSON.stringify(verify));
        Object.assign(report, { phases: [assess, verify] });
        seal(root, report, {
            files: {
                'publications.json': '',
                'evidence.json': '',
                'phases/assess-unit-1.json': '',
                'phases/verify-unit-1.json': '',
            },
        });
        const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
        const fetcher: typeof fetch = async (input, init) => {
            const url = String(input);
            if (init?.method === 'POST') {
                const body = JSON.parse(String(init.body));
                writes.push({ url, body });
                return new Response(JSON.stringify({ id: url.endsWith('/reviews') ? 8 : 7 }), { status: 201 });
            }
            if (url.includes('/comments?')) return new Response('[]');
            if (url.endsWith('/pulls/1'))
                return new Response(
                    JSON.stringify({
                        number: 1,
                        base: { sha: base, ref: 'alpha', repo: { full_name: 'acme/project' } },
                        head: { sha: head },
                    }),
                );
            throw new Error('Unexpected request');
        };
        const result = await publishGitHubReview({
            runDir: root,
            githubDir: root,
            postComment: true,
            inlineComments: true,
            token: 'fixture-token',
            fetch: fetcher,
        });
        expect(result).toMatchObject({ exitCode: 0, commentStatus: 'created', inlineStatus: 'posted' });
        const review = writes.find((w) => w.url.endsWith('/reviews'))!.body;
        expect(review).toMatchObject({
            event: 'COMMENT',
            commit_id: head,
            comments: [expect.objectContaining({ path: 'new.ts', line: 2, side: 'RIGHT' })],
        });
        expect((review.comments as { body: string }[])[0]!.body).toContain('```suggestion\ngood\n```');
        expect(writes[0]!.body.body).toContain('<summary>Run details');
        expect(JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')).decision.exitCode).toBe(1);
        const failed = { ...verify, status: 'failed' as const };
        Object.assign(report, { phases: [assess, failed] });
        writeFileSync(join(root, 'phases/verify-unit-1.json'), JSON.stringify(failed));
        seal(root, report, {
            files: {
                'publications.json': '',
                'evidence.json': '',
                'phases/assess-unit-1.json': '',
                'phases/verify-unit-1.json': '',
            },
        });
        await expect(
            publishGitHubReview({
                runDir: root,
                githubDir: root,
                postComment: true,
                inlineComments: true,
                token: 'fixture-token',
                fetch: async () => {
                    throw new Error('must not contact Github');
                },
            }),
        ).rejects.toThrow();
        // A saved run needs no model-plan phase. Failed verification cannot promote proposals,
        // but a new independent verification may reuse the exact completed assessment.
        const resumedVerify = createPhaseRecord({
            ...common,
            phase: 'verify',
            attempt: 2,
            inputRefs: [...refs, { ref: 'phase:assess:unit:1', hash: digest(assess) }],
            output: verify.output,
        });
        const resumedPhases = [assess, failed, resumedVerify];
        Object.assign(report, { phases: resumedPhases });
        writeFileSync(join(root, 'phases/verify-unit-2.json'), JSON.stringify(resumedVerify));
        seal(root, report, {
            files: {
                'publications.json': '',
                'evidence.json': '',
                'phases/assess-unit-1.json': '',
                'phases/verify-unit-1.json': '',
                'phases/verify-unit-2.json': '',
            },
        });
        expect(resumedPhases.filter((phase) => phase.phase === 'assess')).toHaveLength(1);
        expect(resumedPhases.some((phase) => phase.phase === 'plan')).toBe(false);
        expect(() => validatePublicationArtifacts(root, report, join(root, 'report.json'))).not.toThrow();
        const unsupportedClean = {
            ...report,
            findings: [],
            verification: { complete: true },
            phases: [
                createPhaseRecord({
                    ...common,
                    phase: 'verify',
                    attempt: 2,
                    inputRefs: refs,
                    output: [{ assessmentId: 'criterion', disposition: 'accept', findings: [] }],
                }),
            ],
        };
        writeFileSync(join(root, 'phases/verify-unit-2.json'), JSON.stringify(unsupportedClean.phases[0]));
        seal(root, unsupportedClean, {
            files: {
                'publications.json': '',
                'evidence.json': '',
                'phases/verify-unit-2.json': '',
            },
        });
        expect(() => validatePublicationArtifacts(root, unsupportedClean, join(root, 'report.json'))).toThrow(
            'publication_stale_verification',
        );
        // The engine reconciles one supported issue found under two governing contexts.
        report.entries.push({
            assessmentId: 'second-criterion',
            nodeId: 'context://engineering/second-rule',
            version: 1,
        });
        const second = {
            ...f,
            findingId: 'second-source',
            assessmentIds: ['second-criterion'],
            checkIds: ['second-check'],
        };
        const common2 = { ...common, assessmentIds: ['criterion', 'second-criterion'] };
        const refs2 = [
            { ref: 'manifest.json', hash: digest(prepared) },
            { ref: 'publications.json', hash: digest(publications) },
        ];
        const original2 = {
            ...second,
            verified: false,
            proposedReplacement: { ...second.proposedReplacement, verified: false },
        };
        const assess2 = createPhaseRecord({
            ...common2,
            phase: 'assess',
            inputRefs: refs2,
            output: [proposal, { result: { assessmentId: 'second-criterion' }, findings: [original2] }],
        });
        const verify2 = createPhaseRecord({
            ...common2,
            phase: 'verify',
            inputRefs: [...refs2, { ref: 'phase:assess:unit:1', hash: digest(assess2) }],
            output: [
                {
                    assessmentId: 'criterion',
                    disposition: 'accept',
                    findings: [{ findingId: f.findingId, accepted: true, suggestionAccepted: true }],
                },
                {
                    assessmentId: 'second-criterion',
                    disposition: 'accept',
                    findings: [{ findingId: second.findingId, accepted: true, suggestionAccepted: true }],
                },
            ],
        });
        const merged = reconcileFindings([f, second] as unknown as ReviewFinding[]);
        expect(merged).toHaveLength(1);
        expect(merged[0]!.assessmentIds).toEqual(['criterion', 'second-criterion']);
        Object.assign(report, { findings: merged, phases: [assess2, verify2] });
        writeFileSync(join(root, 'phases/assess-unit-1.json'), JSON.stringify(assess2));
        writeFileSync(join(root, 'phases/verify-unit-1.json'), JSON.stringify(verify2));
        const files = {
            'publications.json': '',
            'evidence.json': '',
            'phases/assess-unit-1.json': '',
            'phases/verify-unit-1.json': '',
        };
        seal(root, report, { files });
        writes.length = 0;
        const published = await publishGitHubReview({
            runDir: root,
            githubDir: root,
            postComment: true,
            inlineComments: true,
            token: 'fixture-token',
            fetch: fetcher,
        });
        expect(published).toMatchObject({ exitCode: 0, inlineStatus: 'posted' });
        const comments = writes.find((w) => w.url.endsWith('/reviews'))!.body.comments as { body: string }[];
        expect(comments).toHaveLength(1);
        expect(comments[0]!.body).toContain('engineering/rule');
        expect(comments[0]!.body).toContain('engineering/second-rule');
        // A caller cannot promote an edited criterion union by just resealing the report file.
        merged[0]!.assessmentIds = ['criterion'];
        Object.assign(report, { findings: merged });
        seal(root, report, { files });
        await expect(
            publishGitHubReview({
                runDir: root,
                githubDir: root,
                postComment: true,
                inlineComments: true,
                token: 'fixture-token',
                fetch: async () => {
                    throw new Error('must not contact Github');
                },
            }),
        ).rejects.toThrow('publication_finding_unverified');
    });
});

describe('real governed run publication boundary', () => {
    it('retains the original readable inventory through prepare, model phases and publication', async () => {
        const root = mkdtempSync(join(tmpdir(), 'governed-publish-real-'));
        roots.push(root);
        const git = (args: string[]) =>
            execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
                cwd: root,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: 'Fixture',
                    GIT_AUTHOR_EMAIL: 'fixture@example.test',
                    GIT_COMMITTER_NAME: 'Fixture',
                    GIT_COMMITTER_EMAIL: 'fixture@example.test',
                },
            }).trim();
        git(['init', '--quiet']);
        writeFileSync(join(root, 'route.ts'), 'export const value = false;\n');
        git(['add', 'route.ts']);
        git(['commit', '--quiet', '-m', 'fixture base']);
        const base = git(['rev-parse', 'HEAD']);
        writeFileSync(join(root, 'route.ts'), 'export const value = true;\n');
        git(['add', 'route.ts']);
        git(['commit', '--quiet', '-m', 'fixture head']);
        const head = git(['rev-parse', 'HEAD']);
        const context: Publication = {
            nodeId: 'context://engineering/export-value',
            version: 1,
            title: 'Export value',
            type: 'context',
            subtype: 'standard',
            domainId: 'engineering',
            status: 'published',
            detailLevel: 'full',
            relationships: [],
            content: { kind: 'context', body: 'The exported value must be true.' },
        };
        const skill: Publication = {
            nodeId: reviewer,
            version: 1,
            title: 'Fixture review',
            type: 'skill',
            subtype: 'reviewer',
            domainId: 'engineering',
            status: 'published',
            detailLevel: 'full',
            relationships: [],
            content: {
                kind: 'skill',
                instructions: 'Review each selected pinned context.',
                reviewer: { selections: { contextIds: [context.nodeId] } },
            },
        };
        const scope = {
            reviewerId: reviewer,
            publicationVersion: 1,
            selectionsHash: digest(skill.content.reviewer!.selections),
            entries: [
                {
                    nodeId: context.nodeId,
                    version: 1,
                    subtype: 'standard',
                    reasons: ['selection'],
                    contentHash: digest(context.content),
                },
            ],
            gaps: [],
        };
        const reader: PublishedReader = {
            async read(name, args) {
                return name === 'get_context'
                    ? context
                    : args.includeAssessment
                      ? {
                            ...skill,
                            assessment: {
                                ...scope,
                                scopeIdentity: digest(scope),
                                complete: true,
                                totalMatched: 1,
                                offset: 0,
                                nextOffset: null,
                            },
                        }
                      : skill;
            },
        };
        const prepared = await prepareReview({ repository: root, base, head, reviewerId: reviewer, reader }),
            runDir = join(root, '.contextrail/reviewer', prepared.state.runId);
        const initial = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
        expect(Object.keys(initial.files).sort()).toEqual(['diff.patch', 'preparation.md']);
        const id = prepared.state.entries[0]!.assessmentId;
        let wireCall = 0,
            assessmentCalls = 0;
        vi.stubEnv('OPENROUTER_API_KEY', 'fixture-provider-key');
        const fetcher: typeof fetch = async (_url, init) => {
            const request = JSON.parse(String(init?.body));
            const names = request.tools.map((t: { function: { name: string } }) => t.function.name);
            const records = Object.values(JSON.parse(readFileSync(join(runDir, 'evidence.json'), 'utf8'))) as {
                ref: string;
                text: string;
                provenance: Record<string, unknown>;
            }[];
            const governing = records.find(
                (r) => r.provenance.nodeId === context.nodeId && r.provenance.path === '/content/body',
            )!;
            const source = records.find((r) => r.provenance.kind === 'source' && r.provenance.path === 'route.ts');
            const cite = (record: { ref: string; text: string }) => ({
                ref: record.ref,
                startSegment: 1,
                endSegment: (record.text.match(/[^\n]*\n|[^\n]+/g) ?? []).length,
            });
            const governingCitation = cite(governing);
            let name: string, input: unknown;
            if (names.includes('submit_assessments') && assessmentCalls++ === 0) {
                name = 'read_source';
                input = { side: 'head', path: 'route.ts' };
            } else if (names.includes('submit_assessments')) {
                const sourceCitation = cite(source!);
                name = 'submit_assessments';
                input = {
                    assessments: [
                        {
                            result: {
                                assessmentId: id,
                                disposition: 'evaluated',
                                confidence: 3,
                                confidenceReason: 'Direct inspected constant.',
                                explanation: 'The exported value is true.',
                                limitations: ['Source inspection only.'],
                            },
                            checks: [
                                {
                                    passage: governingCitation,
                                    interpretation: 'The exported value must be true.',
                                    disposition: 'evaluated',
                                    sourceRefs: [sourceCitation],
                                    explanation: 'True is exported.',
                                    contraryEvidence: 'No contrary source evidence.',
                                    missingEvidence: '',
                                },
                            ],
                            findings: [],
                        },
                    ],
                };
            } else {
                name = 'submit_verification';
                input = {
                    entries: [
                        {
                            assessmentId: id,
                            disposition: 'accept',
                            reason: 'The original rule and pinned source agree.',
                            citations: [governingCitation, cite(source!)],
                            missingChecks: [],
                            amendment: null,
                            findings: [],
                        },
                    ],
                };
            }
            const n = ++wireCall;
            return new Response(
                JSON.stringify({
                    id: `fixture-${n}`,
                    object: 'chat.completion',
                    created: 1,
                    model: 'fixture-model',
                    provider: 'fixture-upstream',
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: null,
                                tool_calls: [
                                    {
                                        id: `tool-${n}`,
                                        type: 'function',
                                        function: { name, arguments: JSON.stringify(input) },
                                    },
                                ],
                            },
                            finish_reason: 'tool_calls',
                        },
                    ],
                    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0 },
                }),
                { headers: { 'content-type': 'application/json' } },
            );
        };
        const result = await runReview({
            prepared,
            provider: { provider: 'openrouter', model: 'fixture-model' },
            logLevel: 'quiet',
            feedback: 'off',
            limits: { maxTimeMs: 60000 },
            fetch: fetcher,
        });
        expect(result.state.reviewStatus).toBe('complete');
        expect(result.state.decision?.exitCode).toBe(0);
        const final = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
        expect(final.files['diff.patch']).toBe(initial.files['diff.patch']);
        expect(final.files['preparation.md']).toBe(initial.files['preparation.md']);
        expect(final.files['phases/plan.json']).toBeUndefined();
        expect(result.state.phases.map((phase) => phase.phase)).toEqual(['assess', 'verify']);
        writeFileSync(
            join(root, 'github-input.json'),
            JSON.stringify({
                version: 1,
                repository: 'acme/project',
                pr: 1,
                reviewer,
                base,
                head,
                baseBranch: 'alpha',
            }),
        );
        const published = await publishGitHubReview({
            runDir,
            githubDir: root,
            postComment: true,
            dryRun: true,
            fetch: async () => {
                throw new Error('publication preview must not contact GitHub');
            },
        });
        expect(published).toMatchObject({ exitCode: 0, status: 'preview' });
        writeFileSync(join(runDir, 'preparation.md'), 'changed after the model run');
        await expect(publishGitHubReview({ runDir, githubDir: root, postComment: true, dryRun: true })).rejects.toThrow(
            'publication_artifact_changed',
        );
    });
});
