import { runRecord } from './history.mjs';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { e, guarded, output, read, write } from './common.mjs';

await guarded('summary', () => {
    const root = e.REVIEW_ROOT;
    const at = (name) => (root ? read(join(root, name)) : null);
    const c = at('config.json'),
        fixed = at('comparison.json'),
        review = at('review-status.json');
    let state = null,
        reporting = null,
        directory = null;
    try {
        const runs = join(root, 'comparison/.contextrail/reviewer');
        const dirs = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory());
        if (dirs.length === 1) {
            directory = join(runs, dirs[0].name);
            const candidate = read(join(directory, 'state.json')) ?? read(join(directory, 'report.json'));
            if (
                candidate?.artifact?.base?.commit === fixed?.base &&
                candidate?.artifact?.head?.commit === fixed?.head &&
                candidate?.reviewer?.nodeId === c?.reviewer &&
                candidate?.runId === dirs[0].name &&
                /^[A-Za-z0-9_-]{1,200}$/.test(candidate?.runId ?? '')
            ) {
                state = candidate;
                reporting = read(join(directory, 'reporting-status.json'))?.reporting ?? state.execution?.reporting;
            }
        }
    } catch {
        /* Startup/setup failure can have no run directory. */
    }
    // Model/source text is data: no HTML, images, links, mentions or extra Markdown structure.
    const text = (value, limit = 300) => {
        const flat = String(value ?? 'unavailable').replace(/\p{Cc}/gu, ' ');
        const clipped = flat.length > limit ? flat.slice(0, limit) + '…' : flat;
        return clipped
            .replace(/[\\`*_{}[\]()#+.!|:]/g, '\\$&')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/@/g, '&#64;');
    };
    const oneOf = (value, choices, fallback = 'unknown') => (choices.includes(value) ? value : fallback);
    const number = (value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
    const integer = (value) => number(value) && Number.isSafeInteger(value);
    const display = (value) => (number(value) ? value.toLocaleString('en-US') : 'unavailable');
    const duration = (ms) =>
        number(ms) ? `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(1)}s` : 'unavailable';
    const exit = oneOf(review?.exit, [0, 1, 2], 'not run / interrupted');
    const status = oneOf(reporting?.status, ['received', 'failed', 'pending', 'off'], 'unavailable');
    const completion = oneOf(state?.reviewStatus, ['complete', 'incomplete', 'running', 'not_started']);
    const execution = state?.execution;
    const entries = Array.isArray(state?.entries) ? state.entries : null;
    const count = (key, value) =>
        entries ? entries.filter((entry) => entry?.result?.[key] === value).length : 'unavailable';
    const version =
        integer(state?.reviewer?.version) && state.reviewer.version > 0 ? state.reviewer.version : 'unconfirmed';
    const artifact =
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+\/artifacts\/[0-9]+$/.test(
            e.ARTIFACT_URL ?? '',
        )
            ? e.ARTIFACT_URL
            : null;
    const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c?.repository ?? '') ? c.repository : null;
    const run =
        repository && /^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? '')
            ? `https://github.com/${repository}/actions/runs/${e.GITHUB_RUN_ID}`
            : null;
    const freshness = oneOf(fixed?.freshness, ['current_at_finish', 'current_before_review', 'superseded']);
    const failedStage = ['setup', 'comparison', 'context', 'review', 'evidence'].find(
        (stage) => at(`${stage}-status.json`)?.status === 'failed',
    );
    const health =
        failedStage || (execution && execution.stopReason !== 'finished')
            ? 'Execution did not finish'
            : exit === 1
              ? 'Blocking findings' + (completion !== 'complete' ? '; assessment incomplete' : '')
              : completion !== 'complete'
                ? 'Assessment incomplete'
                : exit === 0
                  ? 'Accepted by configured review policy'
                  : 'Review error';
    // Prefer wire usage: it includes billed HTTP-200 responses rejected by the SDK. Never add SDK and wire records together.
    const wire = Array.isArray(execution?.providerUsage) && execution.providerUsage.length > 0;
    const records = wire ? execution.providerUsage : Array.isArray(execution?.usage) ? execution.usage : [];
    const calls = integer(execution?.calls) ? execution.calls : null;
    const unique = new Map();
    for (const [index, record] of records.entries()) {
        const call = wire ? record?.call : index + 1;
        if (!integer(call) || call < 1 || calls === null || call > calls || unique.has(call)) continue;
        unique.set(call, wire ? record.usage : record);
    }
    const metric = (getter, money = false) => {
        const values = [...unique.values()].map(getter).filter(number);
        if (values.length === 0) return `unavailable (0/${calls ?? '?'} calls reported)`;
        const total = values.reduce((sum, value) => sum + value, 0);
        const value = number(total) ? (money ? `$${total.toFixed(6)} USD` : display(total)) : 'unavailable';
        return `${value} (${values.length}/${calls ?? '?'} calls reported${values.length !== calls ? '; partial' : ''})`;
    };
    const provider = c?.provider;
    const inputDetails = (usage) => usage?.[provider === 'openai' ? 'input_tokens_details' : 'prompt_tokens_details'];
    const outputDetails = (usage) =>
        usage?.[provider === 'openai' ? 'output_tokens_details' : 'completion_tokens_details'];
    const installed = at('package-lock.json')?.packages;
    const sdk = (name) => text(installed?.[`node_modules/${name}`]?.version);
    const rows = [
        ['Assessment', completion],
        [
            'PR context',
            execution?.prContext
                ? `Discussion ${text(execution.prContext.discussion)}; ${display(execution.prContext.historyRuns)} retained runs; previous head ${text(execution.prContext.previousHead)}`
                : 'Not supplied',
        ],
        ['Review exit', exit],
        ['Execution stop', text(execution?.stopReason)],
        ['Review duration', duration(execution?.elapsedMs)],
        [
            'Elapsed before summary',
            c?.startedAt && Number.isFinite(Date.parse(c.startedAt))
                ? duration(Date.now() - Date.parse(c.startedAt))
                : 'unavailable',
        ],
        ['Calls / completed SDK steps', `${display(execution?.calls)} / ${display(execution?.steps)}`],
        [
            'Provider / requested model / effort',
            `${text(provider)} / ${text(c?.model)} / ${text(c?.effort || 'provider default')}`,
        ],
        [
            'Returned provider / model',
            Array.isArray(execution?.returnedIdentities)
                ? [
                      ...new Set(
                          execution.returnedIdentities.map(
                              (identity) => `${text(identity?.provider)} / ${text(identity?.model)}`,
                          ),
                      ),
                  ]
                      .slice(0, 5)
                      .join('; ') || 'unavailable'
                : 'unavailable',
        ],
        [
            'Runtime',
            `Node ${text(c?.nodeVersion)}; AI SDK ${sdk('ai')}; OpenRouter adapter ${sdk('@openrouter/ai-sdk-provider')}; Zod ${sdk('zod')}`,
        ],
        ['Reported model cost', metric((usage) => usage?.cost, true)],
        [
            'Input tokens (cumulative across calls)',
            metric((usage) =>
                wire ? usage?.[provider === 'openai' ? 'input_tokens' : 'prompt_tokens'] : usage?.inputTokens,
            ),
        ],
        ['Total tokens', metric((usage) => (wire ? usage?.total_tokens : usage?.totalTokens))],
        [
            'Cached input tokens',
            metric((usage) => (wire ? inputDetails(usage)?.cached_tokens : usage?.cachedInputTokens)),
        ],
        [
            'Output tokens (includes reasoning)',
            metric((usage) =>
                wire ? usage?.[provider === 'openai' ? 'output_tokens' : 'completion_tokens'] : usage?.outputTokens,
            ),
        ],
        [
            'Reasoning tokens (part of output)',
            metric((usage) => (wire ? outputDetails(usage)?.reasoning_tokens : usage?.reasoningTokens)),
        ],
        ['Scope entries', entries?.length ?? 'unavailable'],
        [
            'Evaluated / not applicable / unresolved / not evaluated',
            ['evaluated', 'not_applicable', 'unresolved', 'not_evaluated']
                .map((value) => count('disposition', value))
                .join(' / '),
        ],
        [
            'Binding violations / behavioral defects / guidance departures',
            ['binding_violation', 'behavioral_defect', 'guidance_departure']
                .map((value) => count('finding', value))
                .join(' / '),
        ],
        [
            'ContextRail reporting',
            `${status}${status === 'received' ? ' (ingestion receipt only)' : '; no receipt confirmed'}`,
        ],
        [
            'Comparison',
            freshness === 'current_at_finish'
                ? 'Matched current PR at finish; verify SHAs before use'
                : freshness === 'superseded'
                  ? 'SUPERSEDED; historical result only'
                  : 'Currency unknown; verify SHAs before use',
        ],
        ['Evidence upload', oneOf(e.ARTIFACT_OUTCOME, ['success', 'failure', 'skipped', 'cancelled'])],
    ];
    const alerts = [
        c?.feedback === 'send' && status !== 'received' ? 'ContextRail reporting receipt not confirmed' : '',
        e.ARTIFACT_OUTCOME !== 'success' ? 'Evidence upload not confirmed' : '',
        freshness === 'superseded' ? 'Comparison superseded' : '',
    ].filter(Boolean);
    const findings =
        entries?.filter((entry) =>
            ['binding_violation', 'behavioral_defect', 'guidance_departure'].includes(entry?.result?.finding),
        ) ?? [];
    const unresolved = entries?.filter((entry) => entry?.result?.disposition === 'unresolved') ?? [];
    const lines = [
        '### ContextRail review',
        `**${health}.**`,
        alerts.length ? `**Operational alerts:** ${alerts.join('; ')}.` : '',
        fixed
            ? `PR #${text(fixed.pr)}: ${text(fixed.base)} → ${text(fixed.head)}.`
            : 'Comparison unavailable; no review result confirmed.',
        `Package: ${text(c?.packageVersion)}. Reviewer: ${text(c?.reviewer)} @ ${version}. Run ID: ${text(state?.runId)}.`,
        '| Health / performance | Observed |\n| --- | --- |\n' +
            rows.map(([key, value]) => `| ${key} | ${value} |`).join('\n'),
        'Cost is provider-reported model usage, not a verified invoice or infrastructure cost. Partial/missing coverage is not zero cost. Output already includes reasoning; do not add it again.',
        failedStage ? `Action ${failedStage} failed; no successful setup/review is implied.` : '',
    ];
    if (findings.length) {
        lines.push('#### Findings');
        for (const entry of findings.slice(0, 5))
            lines.push(
                `- **${text(entry.result.finding)} — ${text(entry.nodeId)}:** ${text(entry.result.explanation, 500)} Correction: ${text(entry.result.correction, 400)}`,
            );
        if (findings.length > 5) lines.push(`${findings.length - 5} additional findings are in the artifact.`);
    }
    if (unresolved.length) {
        lines.push('#### Unresolved assessments');
        for (const entry of unresolved.slice(0, 5))
            lines.push(`- **${text(entry.nodeId)}:** ${text(entry.result.explanation, 400)}`);
        if (unresolved.length > 5)
            lines.push(`${unresolved.length - 5} additional unresolved entries are in the artifact.`);
    }
    if (state && directory && execution?.stopReason !== 'finished') {
        try {
            const stopped = readFileSync(join(directory, 'audit.jsonl'), 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
                .findLast((event) => event.kind === 'execution_stopped');
            if (stopped) {
                lines.push(
                    `Failure: ${text(stopped.data?.category)}; HTTP ${display(stopped.data?.status)}; call ${display(stopped.data?.call)}.`,
                );
                for (const issue of (stopped.data?.details?.validation ?? []).slice(0, 3)) {
                    lines.push(
                        `- Validation ${text(issue.code)} at ${text(Array.isArray(issue.path) ? issue.path.join('.') : 'unknown')}: expected ${text(issue.expected)}, actual ${text(issue.actual)}.`,
                    );
                }
            }
        } catch {
            /* Missing diagnostic evidence is not success. */
        }
    }
    lines.push(
        [
            run ? `[Workflow run](${run})` : '',
            artifact ? `[Artifact bundle](${artifact})` : 'No artifact URL available.',
        ]
            .filter(Boolean)
            .join(' · '),
        'Full reports/audit may contain source and model conversations. Summary text contains model judgments; review policy acceptance does not certify compliance.',
    );
    const markdown = lines.filter(Boolean).join('\n\n') + '\n';
    if (state) output('run-id', state.runId);
    output('feedback-status', status);
    appendFileSync(e.GITHUB_STEP_SUMMARY, markdown);
    if (root) writeFileSync(join(root, 'summary.md'), markdown, { mode: 0o600 });
    if (root && c && /^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(e.GITHUB_RUN_ATTEMPT ?? '')) {
        const costs = [...unique.values()].map((usage) => usage?.cost).filter(number);
        write(
            join(root, 'comment-run.json'),
            runRecord(
                { ...c, githubRun: e.GITHUB_RUN_ID, githubAttempt: Number(e.GITHUB_RUN_ATTEMPT) },
                fixed,
                state,
                exit,
                costs.length ? costs.reduce((sum, v) => sum + v, 0) : null,
                costs.length === calls && calls > 0,
            ),
        );
    }
});
