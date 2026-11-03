import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CitationError } from './evidence.js';
export type LogLevel = 'quiet' | 'info' | 'debug';
const fields = new Set([
    'phase',
    'workUnitId',
    'attempt',
    'call',
    'status',
    'code',
    'tool',
    'count',
    'bytes',
    'readCount',
    'elapsedMs',
    'hash',
    'inputHash',
    'outputHash',
    'evidenceRefs',
    'stopReason',
    'provider',
    'model',
    'usage',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'reasoningTokens',
    'cost',
    'missing',
    'details',
    'causes',
    'validation',
    'citation',
    'ref',
    'refHash',
    'path',
    'expected',
    'actual',
    'finishReason',
    'reporting',
    'exitCode',
    'complete',
    'reservedTurns',
    'knownCost',
    'usageComplete',
    'corrections',
    'assessmentId',
    'entryIndex',
    'checkIndex',
    'rejectedRefHash',
    'allowedRefCount',
    'omittedCount',
    'newlyAccepted',
    'alreadyAccepted',
    'remaining',
]);
const secretValues = () =>
    Object.entries(process.env)
        .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/u.test(key) && value && value.length >= 8)
        .map(([, value]) => value!);
/** Operational records may retain assessment text; diagnostics never receive those bodies. */
export function sanitizeRecord<T>(value: T): T {
    const secrets = secretValues().sort((left, right) => right.length - left.length);
    let serialized = JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item !== 'string') return item;
        let text = item;
        for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
        return text;
    });
    if (serialized === undefined) return value;
    // Keys can also contain escaped values; operate on their JSON encoding, never raw escape fragments.
    for (const secret of secrets) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    return JSON.parse(serialized) as T;
}
function bounded(value: unknown, depth = 0, arrayLimit = 32): unknown {
    if (depth > 6) return null;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return /^[A-Za-z0-9_./:@+[\] -]{0,220}$/u.test(value) ? value : '[omitted]';
    if (Array.isArray(value)) return value.slice(0, arrayLimit).map((v) => bounded(v, depth + 1));
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => fields.has(key))
                .map(([key, item]) => [
                    key,
                    key === 'citation'
                        ? safeCitationDetails(item)
                        : key === 'ref'
                          ? safeEvidenceRef(item)
                          : key === 'refHash'
                            ? safeRefHash(item)
                            : bounded(item, depth + 1, key === 'corrections' ? 100 : 32),
                ]),
        );
    return null;
}
export class Diagnostics {
    private writes = Promise.resolve();
    constructor(
        readonly directory: string,
        readonly runId: string,
        readonly level: LogLevel,
        private readonly log: (line: string) => void = (line) => process.stderr.write(line),
    ) {}
    event(kind: string, data: Record<string, unknown> = {}) {
        const record = sanitizeRecord({ time: new Date().toISOString(), runId: this.runId, kind, data: bounded(data) });
        const operation = this.writes.then(() =>
            appendFile(join(this.directory, 'diagnostics.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 }),
        );
        this.writes = operation.catch(() => undefined);
        if (
            kind.endsWith('_failed') ||
            kind === 'execution_stopped' ||
            this.level === 'debug' ||
            (this.level === 'info' &&
                ['phase_started', 'phase_completed', 'phase_failed', 'review_finalized'].includes(kind))
        )
            this.log(JSON.stringify(record) + '\n');
        return operation;
    }
    flush() {
        return this.writes;
    }
}

const validatorCodes = new Set([
    'assessment_coverage_mismatch',
    'check_requires_own_governing_passage',
    'structured_requirement_unaccounted',
    'check_source_evidence_required',
    'missing_evidence_need_required',
    'unresolved_required_check',
    'nonapplicability_check_mismatch',
    'distinct_finding_required',
    'finding_aggregate_mismatch',
    'blocking_finding_aggregate_mismatch',
    'foreign_finding_check',
    'foreign_assessment_id',
    'finding_source_required',
    'invalid_replacement_range',
    'verification_governing_evidence_required',
    'verification_acceptance_inconsistent',
    'verification_source_required',
    'unproposed_suggestion_acceptance',
    'phase_already_submitted',
]);
const schemaFields = new Set([
    'entries',
    'assessmentId',
    'applicability',
    'reason',
    'workUnit',
    'checks',
    'passage',
    'interpretation',
    'surfaces',
    'evidenceNeeds',
    'assessments',
    'result',
    'revisionOf',
    'disposition',
    'adherence',
    'confidence',
    'confidenceReason',
    'finding',
    'explanation',
    'consequence',
    'correction',
    'limitations',
    'citations',
    'ref',
    'quote',
    'start',
    'end',
    'startSegment',
    'endSegment',
    'checkId',
    'sourceRefs',
    'contraryEvidence',
    'missingEvidence',
    'findings',
    'classification',
    'checkIds',
    'locationRefs',
    'proposedReplacement',
    'path',
    'blob',
    'startLine',
    'endLine',
    'before',
    'replacement',
    'missingChecks',
    'findingId',
    'accepted',
    'suggestionAccepted',
]);
const schemaCodes = new Set([
    'invalid_type',
    'invalid_value',
    'too_small',
    'too_big',
    'invalid_format',
    'unrecognized_keys',
    'invalid_union',
]);
const citationCodes = new Set(['citation_unknown', 'citation_absent', 'citation_ambiguous', 'citation_range_invalid']);
const safeEvidenceRef = (value: unknown) =>
    typeof value === 'string' && /^evidence:[a-f0-9]{64}$/u.test(value) ? value : null;
const safeRefHash = (value: unknown) =>
    typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : null;
function ownData(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    try {
        return Object.getOwnPropertyDescriptor(value, key)?.value;
    } catch {
        return undefined;
    }
}
function citationPath(value: unknown): Array<string | number> {
    if (!Array.isArray(value)) return [];
    try {
        return Array.prototype.slice
            .call(value, 0, 16)
            .map((part: unknown) =>
                typeof part === 'number' && Number.isSafeInteger(part) && part >= 0
                    ? part
                    : typeof part === 'string' && schemaFields.has(part)
                      ? part
                      : '[field]',
            );
    } catch {
        return [];
    }
}
function safeCitationDetails(value: unknown) {
    return {
        path: citationPath(ownData(value, 'path')),
        ref: safeEvidenceRef(ownData(value, 'ref')),
        refHash: safeRefHash(ownData(value, 'refHash')),
    };
}
type SubmissionDiagnostic = {
    code: string;
    details: {
        validation: Array<{ code: string; path: Array<string | number> }>;
        citation?: ReturnType<typeof safeCitationDetails>;
        causes?: string[];
    };
};
function validationCauses(error: unknown) {
    const causes: string[] = [];
    const causeNames = new Set([
        'AI_InvalidToolInputError',
        'AI_NoSuchToolError',
        'AI_JSONParseError',
        'SyntaxError',
        'AI_TypeValidationError',
        'ZodError',
    ]);
    let current: unknown = error,
        issues: unknown[] = [];
    for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
        const value = current as Record<string, unknown>;
        if (typeof value.name === 'string' && causeNames.has(value.name)) causes.push(value.name);
        if (Array.isArray(value.issues)) {
            issues = value.issues;
            break;
        }
        current = value.cause;
    }
    return { causes, issues };
}

/** Emit only finite package-owned categories and known schema field names, never rejected content. */
export function submissionDiagnostics(error: unknown): SubmissionDiagnostic {
    try {
        if (error instanceof CitationError) {
            const rawCode = ownData(error, 'code');
            return {
                code: typeof rawCode === 'string' && citationCodes.has(rawCode) ? rawCode : 'phase_validation_failed',
                details: { validation: [], citation: safeCitationDetails(error) },
            };
        }
    } catch {
        return { code: 'phase_validation_failed', details: { validation: [] } };
    }
    const originalMessage = error instanceof Error ? error.message : '';
    const message = originalMessage.replace(/^citations\.[0-9]+: /u, '');
    let code = validatorCodes.has(message) ? message : 'phase_validation_failed';
    const prefixes: Array<[string, string]> = [
        ['Unknown assessmentId', 'result_identity_invalid'],
        ['Duplicate/stale', 'result_revision_invalid'],
        ['Result shape invalid', 'phase_shape_invalid'],
        ['Unknown evidence ref', 'citation_unknown'],
        ['Quote absent', 'citation_absent'],
        ['Quote ambiguous', 'citation_ambiguous'],
        ['Cite an exact governing', 'result_governing_passage_required'],
        ['Evaluated judgments require', 'result_evidence_or_score_invalid'],
        ['Findings need', 'result_correction_required'],
        ['Pinned publication unavailable', 'result_publication_unavailable'],
        ['A supported unmet criterion needs', 'result_finding_score_inconsistent'],
        ['Adherence below 2 requires', 'result_unmet_finding_required'],
        ['Unresolved/nonapplicable judgments', 'result_disposition_score_inconsistent'],
    ];
    for (const [prefix, category] of prefixes) if (message.startsWith(prefix)) code = category;
    const { causes, issues } = validationCauses(error);
    if (causes.includes('AI_JSONParseError') || causes.includes('SyntaxError')) code = 'phase_json_invalid';
    else if (causes.includes('AI_NoSuchToolError')) code = 'phase_tool_unknown';
    else if (causes.includes('AI_InvalidToolInputError')) code = 'phase_tool_input_invalid';
    if (issues.length) code = 'phase_shape_invalid';
    const validation = issues.slice(0, 16).map((raw: unknown) => {
        const issue = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        return {
            code: typeof issue.code === 'string' && schemaCodes.has(issue.code) ? issue.code : 'other',
            path: Array.isArray(issue.path)
                ? issue.path
                      .slice(0, 16)
                      .map((part: unknown) =>
                          typeof part === 'number' && Number.isSafeInteger(part)
                              ? part
                              : typeof part === 'string' && schemaFields.has(part)
                                ? part
                                : '[field]',
                      )
                : [],
        };
    });
    return { code, details: { validation, ...(causes.length ? { causes } : {}) } };
}

/** AI SDK 7 stringifies invalid tool-call errors in step.content; original calls retain structured causes. */
export function submissionToolDiagnostics(
    toolError: { toolCallId: string; error: unknown },
    toolCalls: ReadonlyArray<{ toolCallId: string }>,
) {
    const original = toolCalls.find((call) => call.toolCallId === toolError.toolCallId);
    const error = original && 'error' in original && original.error !== undefined ? original.error : toolError.error;
    return submissionDiagnostics(error);
}
