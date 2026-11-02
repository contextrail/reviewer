import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { githubRequest } from './common.mjs';

export const reviewMarker = (c) =>
    `<!-- contextrail-review:${createHash('sha256').update(c.reviewer).digest('hex').slice(0, 24)} -->`;
const digits = (v) => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const numeric = (v) =>
    v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER);
const sha = (v) => v === null || (typeof v === 'string' && /^[a-f0-9]{40}$/.test(v));
const small = (v, n = 500) => typeof v === 'string' && v.length <= n && !/\p{Cc}/u.test(v);
const clip = (v, n) =>
    String(v ?? '')
        .replace(/\p{Cc}/gu, ' ')
        .slice(0, n);
const dispositions = ['evaluated', 'unresolved', 'not_applicable', 'not_evaluated'];
const findings = ['none', 'binding_violation', 'behavioral_defect', 'guidance_departure'];
const statuses = ['complete', 'incomplete', 'running', 'not_started', 'unknown'];
export async function findReviewComment(c) {
    let previous = null;
    for (let page = 1; page <= 10; page++) {
        const comments = await githubRequest(c, `/issues/${c.pr}/comments?per_page=100&page=${page}`);
        if (!Array.isArray(comments)) throw new Error('comment_lookup_failed');
        for (const comment of comments) {
            if (
                comment?.user?.login === 'github-actions[bot]' &&
                comment.user.type === 'Bot' &&
                typeof comment.body === 'string' &&
                comment.body.startsWith(reviewMarker(c) + '\n') &&
                Number.isSafeInteger(comment.id) &&
                comment.id > 0 &&
                (!previous || comment.id > previous.id)
            )
                previous = comment;
        }
        if (comments.length < 100) return previous;
    }
    throw new Error('comment_lookup_incomplete');
}
function checked(value, c) {
    if (
        value?.version !== 1 ||
        value.repository !== c.repository ||
        value.pr !== c.pr ||
        value.reviewer !== c.reviewer ||
        !integer(value.omitted) ||
        !Array.isArray(value.runs) ||
        value.runs.length > 10
    )
        return null;
    const runs = [];
    for (const row of value.runs) {
        if (
            !(
                row?.cliRunId === null ||
                (typeof row?.cliRunId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(row.cliRunId))
            ) ||
            !digits(row?.id) ||
            !integer(row.attempt) ||
            row.attempt < 1 ||
            row.attempt > 1000000 ||
            !sha(row.base) ||
            !sha(row.head) ||
            !small(row.at, 40) ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at) ||
            !Number.isFinite(Date.parse(row.at)) ||
            !statuses.includes(row.assessment) ||
            !['finished', 'failed', 'unknown'].includes(row.execution) ||
            ![null, 0, 1, 2].includes(row.exit) ||
            !integer(row.findings) ||
            !integer(row.unresolved) ||
            !numeric(row.durationMs) ||
            !numeric(row.cost) ||
            typeof row.costComplete !== 'boolean' ||
            !small(row.packageVersion, 100) ||
            !numeric(row.reviewerVersion) ||
            !['openai', 'openrouter', 'unknown'].includes(row.provider) ||
            !small(row.model, 200) ||
            !/^[A-Za-z0-9._:/-]*$/.test(row.model) ||
            !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(row.effort)
        )
            return null;
        runs.push(
            Object.fromEntries(
                [
                    'id',
                    'cliRunId',
                    'attempt',
                    'base',
                    'head',
                    'at',
                    'assessment',
                    'execution',
                    'exit',
                    'findings',
                    'unresolved',
                    'durationMs',
                    'cost',
                    'costComplete',
                    'packageVersion',
                    'reviewerVersion',
                    'provider',
                    'model',
                    'effort',
                ].map((key) => [key, row[key]]),
            ),
        );
    }
    let assessment = null;
    if (value.assessment !== null) {
        const a = value.assessment;
        if (
            !a ||
            !sha(a.base) ||
            !a.base ||
            !sha(a.head) ||
            !a.head ||
            !digits(a.run) ||
            typeof a.cliRunId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,200}$/.test(a.cliRunId) ||
            !integer(a.attempt) ||
            a.attempt < 1 ||
            !numeric(a.reviewerVersion) ||
            !small(a.scopeIdentity, 150) ||
            !['openai', 'openrouter', 'unknown'].includes(a.provider) ||
            !small(a.model, 200) ||
            !/^[A-Za-z0-9._:/-]*$/.test(a.model) ||
            !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(a.effort) ||
            !Array.isArray(a.entries) ||
            a.entries.length > 30 ||
            !integer(a.omitted)
        )
            return null;
        const entries = [];
        for (const entry of a.entries) {
            if (
                !small(entry?.nodeId) ||
                !/^context:\/\/[A-Za-z0-9._/-]+$/.test(entry.nodeId) ||
                !integer(entry.version) ||
                entry.version < 1 ||
                !dispositions.includes(entry.disposition) ||
                !findings.includes(entry.finding) ||
                !small(entry.explanation, 300) ||
                !small(entry.correction, 200)
            )
                return null;
            entries.push(
                Object.fromEntries(
                    ['nodeId', 'version', 'disposition', 'finding', 'explanation', 'correction'].map((key) => [
                        key,
                        entry[key],
                    ]),
                ),
            );
        }
        assessment = {
            base: a.base,
            head: a.head,
            run: a.run,
            cliRunId: a.cliRunId,
            attempt: a.attempt,
            reviewerVersion: a.reviewerVersion,
            scopeIdentity: a.scopeIdentity,
            provider: a.provider,
            model: a.model,
            effort: a.effort,
            entries,
            omitted: a.omitted,
        };
    }
    return {
        version: 1,
        repository: c.repository,
        pr: c.pr,
        reviewer: c.reviewer,
        runs,
        omitted: value.omitted,
        assessment,
    };
}
export function readHistory(body, c) {
    if (typeof body !== 'string' || body.length > 65536) return null;
    const match = body.match(/\n<!-- contextrail-state:v1:([A-Za-z0-9+/=]{1,40000}) -->\n/);
    if (!match) return null;
    try {
        const decoded = Buffer.from(match[1], 'base64');
        if (decoded.toString('base64') !== match[1] || decoded.length > 30000) return null;
        return checked(JSON.parse(decoded.toString('utf8')), c);
    } catch {
        return null;
    }
}
export function runRecord(c, fixed, state, exit, cost, costComplete) {
    const execution = state?.execution;
    const entries = Array.isArray(state?.entries) ? state.entries : [];
    const row = {
        provider: ['openai', 'openrouter'].includes(c.provider) ? c.provider : 'unknown',
        model: clip(c.model, 200),
        effort: c.effort ?? '',
        cliRunId: typeof state?.runId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(state.runId) ? state.runId : null,
        id: c.githubRun,
        attempt: c.githubAttempt,
        at: new Date().toISOString(),
        base: fixed?.base ?? null,
        head: fixed?.head ?? null,
        assessment: statuses.includes(state?.reviewStatus) ? state.reviewStatus : 'unknown',
        execution: execution?.stopReason === 'finished' ? 'finished' : execution || exit === 2 ? 'failed' : 'unknown',
        exit: [0, 1, 2].includes(exit) ? exit : null,
        findings: entries.filter((entry) => findings.slice(1).includes(entry?.result?.finding)).length,
        unresolved: entries.filter((entry) => entry?.result?.disposition === 'unresolved').length,
        durationMs: numeric(execution?.elapsedMs) ? (execution?.elapsedMs ?? null) : null,
        cost: numeric(cost) ? cost : null,
        costComplete,
        packageVersion: clip(c.packageVersion, 100),
        reviewerVersion: numeric(state?.reviewer?.version) ? (state?.reviewer?.version ?? null) : null,
    };
    const assessment =
        execution?.stopReason === 'finished' &&
        entries.length > 0 &&
        entries.every(
            (entry) =>
                dispositions.includes(entry?.result?.disposition) &&
                entry.result.disposition !== 'not_evaluated' &&
                typeof entry.nodeId === 'string' &&
                integer(entry.version) &&
                entry.version > 0,
        )
            ? {
                  base: fixed.base,
                  head: fixed.head,
                  run: row.id,
                  cliRunId: row.cliRunId,
                  attempt: row.attempt,
                  reviewerVersion: row.reviewerVersion,
                  provider: row.provider,
                  model: row.model,
                  effort: row.effort,
                  scopeIdentity: clip(state.scopeIdentity, 150),
                  omitted: Math.max(0, entries.length - 30),
                  entries: entries.slice(0, 30).map((entry) => ({
                      nodeId: entry.nodeId,
                      version: entry.version,
                      disposition: entry.result.disposition,
                      finding: entry.result.finding,
                      explanation:
                          entry.result.finding !== 'none' || entry.result.disposition === 'unresolved'
                              ? clip(entry.result.explanation, 300)
                              : '',
                      correction: entry.result.finding !== 'none' ? clip(entry.result.correction, 200) : '',
                  })),
              }
            : null;
    return { row, assessment };
}
export function withHistory(summary, previous, current, c) {
    const old = readHistory(previous?.body, c);
    const runs = (old?.runs ?? []).filter(
        (row) =>
            row.id !== current.row.id || row.attempt !== current.row.attempt || row.cliRunId !== current.row.cliRunId,
    );
    runs.push(current.row);
    runs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : a.attempt - b.attempt));
    const history = {
        version: 1,
        repository: c.repository,
        pr: c.pr,
        reviewer: c.reviewer,
        runs,
        omitted: old?.omitted ?? 0,
        assessment: current.assessment ?? old?.assessment ?? null,
    };
    while (history.runs.length > 10) {
        history.runs.shift();
        history.omitted++;
    }
    const render = () => {
        const rows = history.runs.map(
            (r) =>
                `| [${r.id}/${r.attempt}](https://github.com/${c.repository}/actions/runs/${r.id}/attempts/${r.attempt}) | ${r.at.slice(0, 16).replace('T', ' ')} UTC | ${r.head?.slice(0, 7) ?? 'unknown'} | \`${r.provider}/${r.model} ${r.effort}\` | ${r.execution} / ${r.assessment} | ${r.exit ?? '?'} | ${r.findings} | ${r.unresolved} | ${r.durationMs === null ? '?' : (r.durationMs / 1000).toFixed(1) + 's'} | ${r.cost === null ? 'unavailable' : '$' + r.cost.toFixed(6) + (r.costComplete ? '' : ' partial')} |`,
        );
        const table = `\n#### Review history\n\n| Run / attempt | Time | Head | Requested model | Execution / assessment | Exit | Findings | Unresolved | Duration | Reported USD |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nLatest ${history.runs.length} tracked rows retained; ${history.omitted} older tracked rows omitted. Pre-adoption runs and skipped or failed comment writes may be absent. [All workflow runs](https://github.com/${c.repository}/actions). Hidden state is a mutable convenience record, not a secret or review attestation.\n`;
        const encoded = Buffer.from(JSON.stringify(history)).toString('base64');
        return `${reviewMarker(c)}\n<!-- contextrail-run:${current.row.id}:${current.row.attempt} -->\n<!-- contextrail-state:v1:${encoded} -->\n${summary}${table}`;
    };
    let body = render();
    while ((body.length > 60000 || Buffer.byteLength(JSON.stringify(history)) > 30000) && history.runs.length > 1) {
        history.runs.shift();
        history.omitted++;
        body = render();
    }
    if (body.length > 60000 || Buffer.byteLength(JSON.stringify(history)) > 30000) {
        history.assessment = null;
        body = render();
    }
    if (!checked(history, c) || body.length > 60000) throw new Error('history_invalid');
    return body;
}
