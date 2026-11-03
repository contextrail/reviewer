import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, prepareReview } from '../src/prepare.js';
import { prepareSemanticCase } from './fixtures/governed-review/prepare-case.mjs';

type SemanticCase = {
    id: string;
    pair: string;
    fixtureVersion?: number;
    contextId: string;
    title: string;
    rule: string;
    before: Record<string, string>;
    after: Record<string, string>;
    expected: { finding: 'binding_violation' | 'none'; issue: string; location: string };
};
const cases = JSON.parse(
    readFileSync(new URL('./fixtures/governed-review/cases.json', import.meta.url), 'utf8'),
) as SemanticCase[];
const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Executes only these checked-in synthetic fixture bodies, never model output or reviewed repository code. */
function fixtureExports(fixture: SemanticCase): Record<string, (...args: unknown[]) => unknown> {
    const module = { exports: {} };
    runInNewContext(fixture.after['route.js']!, { module }, { timeout: 1000 });
    return module.exports;
}

describe('pre-labelled governed semantic comparisons', () => {
    it('contains exactly three violation/counterpart pairs with the same governing rule in each pair', () => {
        expect(cases).toHaveLength(6);
        expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(6);
        for (const pair of ['A', 'B', 'C']) {
            const members = cases.filter((fixture) => fixture.pair === pair);
            expect(members).toHaveLength(2);
            expect(new Set(members.map((fixture) => fixture.rule)).size).toBe(1);
            expect(members.map((fixture) => fixture.expected.finding).sort()).toEqual(['binding_violation', 'none']);
        }
    });

    it.each(cases.filter((fixture) => fixture.pair === 'A'))(
        '$id has the labelled tenant-disclosure behavior',
        (fixture) => {
            const read = fixtureExports(fixture).readDocument!;
            const document = { tenantId: 'tenant-a', body: 'synthetic document' };
            expect(read({ tenantId: 'tenant-a' }, document)).toEqual(document);
            if (fixture.expected.finding === 'binding_violation') {
                expect(read({ tenantId: 'tenant-b' }, document)).toEqual(document);
            } else {
                expect(() => read({ tenantId: 'tenant-b' }, document)).toThrow('forbidden');
            }
        },
    );

    it.each(cases.filter((fixture) => fixture.pair === 'B'))(
        '$id has the labelled published-response behavior',
        (fixture) => {
            const read = fixtureExports(fixture).readCount!;
            const result = read(['one', 'two']) as { count: unknown };
            const contract = JSON.parse(fixture.after['api-contract.json']!) as { response: { count: string } };
            expect(fixture.fixtureVersion).toBe(2);
            expect(contract.response.count).toBe('integer');
            expect(Number.isInteger(result.count)).toBe(fixture.expected.finding === 'none');
            expect(result.count).toBe(fixture.expected.finding === 'none' ? 2 : '2');
            expect(() => read({ length: '2' })).toThrow('invalid count');
            expect(() => read({ length: 1.5 })).toThrow('invalid count');
            // Snapshot length once so a changing getter cannot invalidate the type guard.
            let lengthReads = 0;
            const checked = read({
                get length() {
                    lengthReads++;
                    return lengthReads === 1 ? 2 : 'invalid';
                },
            }) as { count: unknown };
            expect(lengthReads).toBe(1);
            expect(checked.count).toBe(fixture.expected.finding === 'none' ? 2 : '2');
        },
    );

    it.each(cases.filter((fixture) => fixture.pair === 'C'))(
        '$id has the labelled completion and rejection behavior',
        async (fixture) => {
            const save = fixtureExports(fixture).save!;
            let settle: (() => void) | undefined;
            const write = new Promise<void>((resolve) => {
                settle = resolve;
            });
            let completed = false;
            const result = Promise.resolve(save(() => write)).then((value) => {
                completed = true;
                return value;
            });
            // Flush cross-realm promise assimilation without a wall-clock timing assertion.
            await nextTurn();
            expect(completed).toBe(fixture.expected.finding === 'binding_violation');
            settle!();
            await expect(result).resolves.toBe('saved');
            const failure = new Error('synthetic write failed');
            const failed = Promise.resolve(save(() => Promise.reject(failure)));
            if (fixture.expected.finding === 'binding_violation') await expect(failed).resolves.toBe('saved');
            else await expect(failed).rejects.toThrow('synthetic write failed');
        },
    );

    it.each(cases)(
        '$id prepares fixed evidence without leaking the expected outcome into governing material',
        async (fixture) => {
            const preparedCase = await prepareSemanticCase(fixture, { prepareReview, digest });
            directories.push(preparedCase.directory);
            expect(preparedCase.prepared.state.preparationStatus).toBe('prepared');
            expect(preparedCase.prepared.state.entries).toHaveLength(1);
            expect(preparedCase.prepared.state.entries[0].nodeId).toBe(fixture.contextId);
            const material = readFileSync(preparedCase.prepared.materialPath, 'utf8');
            expect(material).not.toContain(fixture.expected.issue);
            expect(preparedCase.prepared.state.reviewer?.content.instructions).not.toContain(fixture.expected.issue);
            expect(preparedCase.prepared.state.artifact.base.commit).not.toBe(
                preparedCase.prepared.state.artifact.head.commit,
            );
            expect(readFileSync(join(preparedCase.repository, 'route.js'), 'utf8')).toBe(fixture.after['route.js']);
        },
    );
});
