import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
    options: {
        installed: { type: 'boolean' },
        url: { type: 'string' },
        token: { type: 'string', default: 'member' },
        org: { type: 'string', default: 'org-1' },
        reviewer: { type: 'string', default: 'skill://engineering/c5-report' },
        feedback: { type: 'string', default: 'send' },
        'repository-attribution': { type: 'boolean' },
    },
});
const { prepareReview, runReview, McpPublishedReader, projectReviewReport } = await import(
    values.installed ? '@contextrail/code-review-agent' : '../dist/index.js'
);
globalThis.AI_SDK_LOG_WARNINGS = false;
process.env.OPENROUTER_API_KEY = 'c5-deterministic-fixture-key';
const repository = await mkdtemp(join(tmpdir(), 'c5-installed-review-'));
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
const reader = new McpPublishedReader(
    values.url,
    values.token,
    values.org,
    { status: 'reported', provider: 'github.com', owner: 'team', name: 'c5-fixture' },
    { repositoryAttribution: values['repository-attribution'] },
);
try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(repository, 'source.ts'), 'export const value = "SENTINEL_LOCAL_SOURCE_C5";\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(repository, 'source.ts'), 'export const value = "SENTINEL_LOCAL_SOURCE_C5_CHANGED";\n');
    git('add', '.');
    git('commit', '-qm', 'head');
    git('remote', 'add', 'origin', 'https://github.com/team/c5-fixture.git');
    const prepared = await prepareReview({ repository, base, head: 'HEAD', reviewerId: values.reviewer, reader });
    assert.equal(prepared.state.preparationStatus, 'prepared');
    let calls = 0;
    const result = await runReview({
        prepared,
        provider: { provider: 'openrouter', model: 'fixture-model' },
        purpose: 'SENTINEL_LOCAL_PURPOSE_C5',
        feedback: values.feedback,
        feedbackSender: reader,
        repositoryAttribution: values['repository-attribution'],
        fetch: async () => {
            const call = ++calls;
            let tools;
            if (call === 1) tools = [{ name: 'read_source', input: { side: 'head', path: 'source.ts' } }];
            else if (call === 2) {
                const records = Object.values(
                    JSON.parse(
                        await readFile(
                            join(repository, '.contextrail', 'reviewer', prepared.state.runId, 'evidence.json'),
                            'utf8',
                        ),
                    ),
                );
                const source = records.find((r) => r.provenance.kind === 'source');
                tools = [
                    {
                        name: 'submit_results',
                        input: {
                            results: prepared.state.entries.map((entry) => {
                                const context = records.find(
                                    (r) =>
                                        r.provenance.kind === 'publication' &&
                                        r.provenance.nodeId === entry.nodeId &&
                                        r.provenance.path === '/content/body',
                                );
                                return {
                                    assessmentId: entry.assessmentId,
                                    revisionOf: null,
                                    disposition: 'evaluated',
                                    adherence: 2,
                                    confidence: 3,
                                    confidenceReason: 'SENTINEL_LOCAL_CONFIDENCE_C5',
                                    finding: 'none',
                                    explanation: 'SENTINEL_LOCAL_EXPLANATION_C5',
                                    consequence: '',
                                    correction: '',
                                    limitations: ['SENTINEL_LOCAL_LIMITATION_C5'],
                                    citations: [source, context].map((r) => ({ ref: r.ref, quote: r.text })),
                                };
                            }),
                        },
                    },
                ];
            } else tools = [{ name: 'finish_review', input: { scope: 'SENTINEL_LOCAL_SCOPE_C5' } }];
            return new Response(
                JSON.stringify({
                    id: `fixture-${call}`,
                    object: 'chat.completion',
                    created: 1,
                    model: 'fixture-model',
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: null,
                                tool_calls: tools.map((t, i) => ({
                                    id: `call-${call}-${i}`,
                                    type: 'function',
                                    function: { name: t.name, arguments: JSON.stringify(t.input) },
                                })),
                            },
                            finish_reason: 'tool_calls',
                        },
                    ],
                    ...(call === 2
                        ? {}
                        : {
                              usage: {
                                  prompt_tokens: call === 1 ? 0 : 12,
                                  completion_tokens: call === 1 ? 0 : 7,
                                  total_tokens: call === 1 ? 0 : 19,
                              },
                          }),
                }),
                { headers: { 'content-type': 'application/json' } },
            );
        },
    });
    assert.equal(result.state.decision.exitCode, 0);
    const projection = projectReviewReport(result.state, values['repository-attribution']);
    assert(!JSON.stringify(projection).includes('SENTINEL'));
    const report = JSON.parse(await readFile(result.reportPath, 'utf8'));
    const state = JSON.parse(await readFile(result.statePath, 'utf8'));
    assert.deepEqual(report, state);
    assert(JSON.stringify(report).includes('SENTINEL_LOCAL_EXPLANATION_C5'));
    const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));
    for (const [name, digest] of Object.entries(manifest.files))
        assert.equal(
            digest,
            `sha256:${createHash('sha256')
                .update(await readFile(join(result.directory, name)))
                .digest('hex')}`,
        );
    console.log(
        JSON.stringify({
            installed: Boolean(values.installed),
            decision: report.decision,
            reporting: report.execution.reporting,
            projection,
            integrity: 'all file hashes reconcile',
            localSentinelsPreserved: true,
        }),
    );
} finally {
    await reader.close();
    await rm(repository, { recursive: true, force: true });
}
