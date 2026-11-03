import { z } from 'zod';
import { digest } from './prepare.js';
import type { Publication } from './contracts.js';
import type { ReadResult } from './source.js';

export const selectionSchema = z.strictObject({
    ref: z.string().min(1).describe('Copy the returned evidence identifier verbatim.'),
    startSegment: z.number().int().positive().describe('First evidence-relative segment index, inclusive.'),
    endSegment: z.number().int().positive().describe('Last evidence-relative segment index, inclusive.'),
});
export const citationSchema = z
    .strictObject({
        ref: z.string().min(1),
        quote: z.string().min(1),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
    })
    .refine((value) => (value.start === undefined) === (value.end === undefined), {
        message: 'Citation offsets must be supplied together.',
        path: ['end'],
    });
export type CitationFailureCode =
    'citation_unknown' | 'citation_absent' | 'citation_ambiguous' | 'citation_range_invalid';
/** Content-free failure identity; rejected quotations never enter exception messages or diagnostics. */
export class CitationError extends Error {
    readonly ref: string | null;
    readonly refHash: string;
    constructor(
        readonly code: CitationFailureCode,
        ref: string,
        readonly path: Array<string | number> = [],
    ) {
        super(
            {
                citation_unknown: 'Unknown evidence ref. Copy a ref returned with pinned guidance or a source read.',
                citation_absent:
                    'Quote absent from that evidence. Copy exact text, preserving whitespace, or read the relevant source range.',
                citation_ambiguous:
                    'Quote ambiguous in that evidence. Include more surrounding text or read a narrower range.',
                citation_range_invalid:
                    'Citation range invalid. Select a narrower returned evidence-relative segment range.',
            }[code],
        );
        this.name = 'CitationError';
        this.ref = /^evidence:[a-f0-9]{64}$/u.test(ref) ? ref : null;
        this.refHash = digest(ref);
    }
}
export type Evidence = {
    ref: string;
    text: string;
    provenance: Record<string, unknown>;
    fragments?: ReadResult['fragments'];
};
export type Citation = z.infer<typeof citationSchema> & {
    start: number;
    end: number;
    provenance: Record<string, unknown>;
    location?: { line: number; column: number };
};
/** Segment indices belong to this evidence record, never to a file or publication's line numbering. */
function evidenceSegments(text: string) {
    return Array.from(text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu), (match, index) => ({
        index: index + 1,
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
    }));
}
/** A single source of text for model inputs: no duplicate full-text representation. */
export function modelEvidence(record: Evidence) {
    return {
        ref: record.ref,
        provenance: record.provenance,
        segments: evidenceSegments(record.text).map(({ index, text }) => ({ index, text })),
    };
}
const MAX_SELECTION_BYTES = 64 * 1024;
export const MAX_SUBMISSION_QUOTE_BYTES = 1024 * 1024;
function parseSelection(input: unknown, path: Array<string | number>) {
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0],
            ref =
                input && typeof input === 'object' && 'ref' in input && typeof input.ref === 'string' ? input.ref : '';
        throw new CitationError('citation_range_invalid', ref, [
            ...path,
            ...(typeof field === 'string' && ['ref', 'startSegment', 'endSegment'].includes(field) ? [field] : []),
        ]);
    }
    return parsed.data;
}
function selectedByteCount(
    text: string,
    start: number,
    end: number,
    maxBytes: number,
    ref: string,
    path: Array<string | number>,
) {
    let bytes = 0;
    // Count UTF-8 size without first allocating the selected quotation. Lone surrogates match
    // Buffer's replacement encoding; segment boundaries never split an intact surrogate pair.
    for (let offset = start; offset < end; offset++) {
        const point = text.codePointAt(offset)!;
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (point > 0xffff) offset++;
        if (bytes > maxBytes) throw new CitationError('citation_range_invalid', ref, [...path, 'endSegment']);
    }
    return bytes;
}
function selectionRange(
    records: Record<string, Evidence>,
    input: unknown,
    path: Array<string | number>,
    maxBytes: number,
) {
    const selection = parseSelection(input, path),
        record = Object.hasOwn(records, selection.ref) ? records[selection.ref] : undefined;
    if (!record) throw new CitationError('citation_unknown', selection.ref, [...path, 'ref']);
    const segments = evidenceSegments(record.text);
    if (selection.startSegment > segments.length)
        throw new CitationError('citation_range_invalid', selection.ref, [...path, 'startSegment']);
    if (selection.endSegment < selection.startSegment || selection.endSegment > segments.length)
        throw new CitationError('citation_range_invalid', selection.ref, [...path, 'endSegment']);
    const start = segments[selection.startSegment - 1]!.start,
        end = segments[selection.endSegment - 1]!.end;
    const bytes = selectedByteCount(record.text, start, end, maxBytes, selection.ref, path);
    return { record, start, end, bytes };
}
/** The caller validates a selection-only model schema before this deterministic transformation. */
export function resolveCitationSelections(
    input: unknown,
    ledger: EvidenceLedger,
    path: Array<string | number> = [],
): unknown {
    let remaining = MAX_SUBMISSION_QUOTE_BYTES;
    const resolve = (value: unknown, currentPath: Array<string | number>): unknown => {
        if (Array.isArray(value)) return value.map((item, index) => resolve(item, [...currentPath, index]));
        if (value && typeof value === 'object') {
            if (
                Object.hasOwn(value, 'ref') ||
                Object.hasOwn(value, 'startSegment') ||
                Object.hasOwn(value, 'endSegment')
            ) {
                const range = selectionRange(
                    ledger.records,
                    value,
                    currentPath,
                    Math.min(MAX_SELECTION_BYTES, remaining),
                );
                remaining -= range.bytes;
                return {
                    ref: range.record.ref,
                    quote: range.record.text.slice(range.start, range.end),
                    start: range.start,
                    end: range.end,
                };
            }
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, resolve(item, [...currentPath, key])]),
            );
        }
        return value;
    };
    return resolve(input, path);
}
function explicitCitationRange(record: Evidence, input: z.infer<typeof citationSchema>, path: Array<string | number>) {
    if (
        !Number.isSafeInteger(input.start) ||
        input.start === undefined ||
        input.start < 0 ||
        input.start >= record.text.length
    )
        throw new CitationError('citation_range_invalid', input.ref, [...path, 'start']);
    if (
        !Number.isSafeInteger(input.end) ||
        input.end === undefined ||
        input.end <= input.start ||
        input.end > record.text.length
    )
        throw new CitationError('citation_range_invalid', input.ref, [...path, 'end']);
    const start = input.start;
    const end = input.end;
    if (record.text.slice(start, end) !== input.quote)
        throw new CitationError('citation_range_invalid', input.ref, [...path, 'quote']);
    return { start, end };
}
function citationRange(record: Evidence, input: z.infer<typeof citationSchema>, path: Array<string | number>) {
    if (input.start !== undefined || input.end !== undefined) return explicitCitationRange(record, input, path);
    const start = record.text.indexOf(input.quote);
    if (start < 0) throw new CitationError('citation_absent', input.ref, path);
    if (record.text.indexOf(input.quote, start + 1) >= 0)
        throw new CitationError('citation_ambiguous', input.ref, path);
    const end = start + input.quote.length;
    return { start, end };
}
function citationLocation(record: Evidence, start: number): Citation['location'] {
    let location: Citation['location'];
    if (record.fragments) {
        let offset = 0;
        for (const fragment of record.fragments) {
            if (start < offset + fragment.text.length) {
                location = { line: fragment.line, column: fragment.column + start - offset };
                break;
            }
            offset += fragment.text.length;
        }
    }
    return location;
}
export class EvidenceLedger {
    readonly records: Record<string, Evidence> = {};
    add(text: string, provenance: Record<string, unknown>, fragments?: ReadResult['fragments']) {
        const ref = `evidence:${digest({ text, provenance }).slice(7)}`;
        this.records[ref] = { ref, text, provenance, ...(fragments ? { fragments } : {}) };
        return this.records[ref]!;
    }
    publication(publication: Publication) {
        const records: Evidence[] = [];
        const visit = (value: unknown, path: string) => {
            if (typeof value === 'string' && value.trim())
                records.push(
                    this.add(value, {
                        kind: 'publication',
                        nodeId: publication.nodeId,
                        version: publication.version,
                        path,
                        contentHash: digest(publication.content),
                    }),
                );
            else if (value && typeof value === 'object')
                for (const [key, child] of Object.entries(value))
                    visit(child, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
        };
        visit(publication.content, '/content');
        return records;
    }
    source(result: ReadResult) {
        if (!result.entry || !result.fragments.length) return null;
        return this.add(
            result.fragments.map((f) => f.text).join(''),
            {
                ...result.entry,
                sourceKind: result.entry.kind,
                kind: 'source',
                start: { line: result.fragments[0]!.line, column: result.fragments[0]!.column },
            },
            result.fragments,
        );
    }
    select(
        input: z.infer<typeof selectionSchema>,
        path: Array<string | number> = [],
        remainingBytes = MAX_SELECTION_BYTES,
    ): Citation {
        const cap =
            Number.isSafeInteger(remainingBytes) && remainingBytes >= 0
                ? Math.min(MAX_SELECTION_BYTES, remainingBytes)
                : 0;
        const range = selectionRange(this.records, input, path, cap);
        return this.cite(
            {
                ref: range.record.ref,
                quote: range.record.text.slice(range.start, range.end),
                start: range.start,
                end: range.end,
            },
            path,
        );
    }
    cite(input: z.infer<typeof citationSchema>, path: Array<string | number> = []): Citation {
        const record = Object.hasOwn(this.records, input.ref) ? this.records[input.ref] : undefined;
        if (!record) throw new CitationError('citation_unknown', input.ref, path);
        const { start, end } = citationRange(record, input, path);
        const location = citationLocation(record, start);
        return {
            ...input,
            start,
            end,
            provenance: record.provenance,
            ...(location ? { location } : {}),
        };
    }
}
