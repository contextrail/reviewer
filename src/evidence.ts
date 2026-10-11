import { z } from 'zod';
import { digest } from './prepare.js';
import type { Publication } from './contracts.js';
import type { ReadResult } from './source.js';

export const citationSchema = z.strictObject({ ref: z.string().min(1), quote: z.string().min(1) });
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
    cite(input: z.infer<typeof citationSchema>): Citation {
        const record = this.records[input.ref];
        if (!record)
            throw new Error('Unknown evidence ref. Copy a ref returned with pinned guidance or a source read.');
        const start = record.text.indexOf(input.quote);
        if (start < 0)
            throw new Error(
                'Quote absent from that evidence. Copy exact text, preserving whitespace, or read the relevant source range.',
            );
        if (record.text.indexOf(input.quote, start + 1) >= 0)
            throw new Error(
                'Quote ambiguous in that evidence. Include more surrounding text or read a narrower range.',
            );
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
        return {
            ...input,
            start,
            end: start + input.quote.length,
            provenance: record.provenance,
            ...(location ? { location } : {}),
        };
    }
}
