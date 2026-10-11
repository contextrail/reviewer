import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PreparationReadError, type Publication, type PublishedReader, type ScopePage } from '../src/contracts.js';
import { digest, prepareReview } from '../src/prepare.js';
import { fixGitIdentity, repositoryEnvironment } from '../src/git.js';

const reviewerId = 'skill://engineering/c1';
const ids = ['context://engineering/a', 'context://engineering/b', 'context://engineering/c'];
const selections = { contextIds: [ids[0]!], domains: [{ domainId: 'engineering', includeDescendants: true }] };
const reviewer: Publication = {
    nodeId: reviewerId,
    domainId: 'engineering',
    title: 'C1 reviewer',
    type: 'skill',
    subtype: 'reviewer',
    status: 'published',
    version: 4,
    detailLevel: 'full',
    relationships: [],
    content: { kind: 'skill', instructions: 'Review every selected context.', reviewer: { selections } },
};
const contexts = ids.map(
    (nodeId, index): Publication => ({
        nodeId,
        domainId: 'engineering',
        title: `Context ${index}`,
        type: 'context',
        subtype: 'standard',
        status: 'published',
        version: index + 1,
        detailLevel: 'full',
        relationships: [],
        content: { kind: 'context', body: `Original prose ${index}.` },
    }),
);
const entries = contexts.map((context, i) => ({
    nodeId: context.nodeId,
    version: context.version,
    subtype: 'standard' as const,
    contentHash: digest(context.content),
    reasons: i === 0 ? ['contextIds[0]', 'domains[0]'] : i === 2 ? [`requires:${ids[1]}@2`] : ['domains[0]'],
}));
const directories: string[] = [];
afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('current-only reviewer publications', () => {
    it.each(['role', 'activatingAreas', 'boundedExpansion', 'reviewScope', 'expectedEvidence'])(
        'rejects retired reviewer section %s from MCP',
        async (field) => {
            const source = reader();
            const result = await run(repository(), {
                async read(name, args) {
                    const value = await source.read(name, args);
                    if (name === 'get_skill' && args.includeAssessment)
                        (value as Publication).content.sections = { [field]: 'retired' };
                    return value;
                },
            });
            expect(result.state.preparationStatus).toBe('incomplete');
            expect(result.state.gaps).toContainEqual({ code: 'contract_validation_failed', reason: 'reviewer' });
        },
    );

    it.each(['assessment', 'model', 'routingHints', 'outputContract', 'intent', 'version'])(
        'rejects retired reviewer metadata %s from MCP',
        async (field) => {
            const repo = repository();
            const source = reader();
            const result = await run(repo, {
                async read(name, args) {
                    const value = await source.read(name, args);
                    if (name === 'get_skill' && args.includeAssessment) {
                        const publication = structuredClone(value) as Publication;
                        (publication.content.reviewer as Record<string, unknown>)[field] = {};
                        return publication;
                    }
                    return value;
                },
            });
            expect(result.state.preparationStatus).toBe('incomplete');
            expect(result.state.gaps.length).toBeGreaterThan(0);
        },
    );
});

describe('fixed Git repository attribution matches the maintained MCP environment contract', () => {
    const unavailable = { status: 'unavailable', reason: 'not_determined' };
    it('preserves tracked, origin, sole and ambiguous remote selection without falling back from invalid attribution', () => {
        const repo = repository();
        const capture = () => repositoryEnvironment(repo.root);
        expect(capture()).toEqual({ status: 'unavailable', reason: 'no_remote' });
        repo.git('remote', 'add', 'upstream', 'git@gitlab.example:group/nested/repo.git');
        const nested = { status: 'reported', provider: 'gitlab.example', owner: 'group/nested', name: 'repo' };
        expect(capture()).toEqual(nested);
        repo.git('remote', 'add', 'secondary', 'ssh://git@gitlab/team/repo.git');
        expect(capture()).toEqual({ status: 'unavailable', reason: 'ambiguous_remote' });
        repo.git('remote', 'add', 'origin', 'git@gitlab.example:team/origin.git');
        expect(capture()).toEqual({ status: 'reported', provider: 'gitlab.example', owner: 'team', name: 'origin' });
        repo.git('config', 'branch.test.remote', 'upstream');
        expect(capture()).toEqual(nested);
        repo.git('config', 'branch.test.remote', 'secondary');
        expect(capture()).toEqual(unavailable);
    });
});
let seed: ReturnType<typeof createRepository> | undefined;
afterAll(() => {
    if (seed) rmSync(seed.root, { recursive: true, force: true });
});
function repository() {
    seed ??= createRepository();
    const root = mkdtempSync(join(tmpdir(), 'reviewer-c1-copy-'));
    directories.push(root);
    cpSync(seed.root, root, { recursive: true });
    const git = (...args: string[]) =>
        execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { root, base: seed.base, head: seed.head, git, artifact: { ...seed.artifact, repository: root } };
}
function createRepository() {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-c1-'));
    const git = (...args: string[]) =>
        execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'test');
    writeFileSync(join(root, 'file.txt'), 'base');
    git('add', 'file.txt');
    git('-c', 'user.name=C1', '-c', 'user.email=c1@example.test', 'commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'file.txt'), 'head');
    git('add', 'file.txt');
    git('-c', 'user.name=C1', '-c', 'user.email=c1@example.test', 'commit', '-m', 'head');
    const head = git('rev-parse', 'HEAD');
    return { root, base, head, git, artifact: fixGitIdentity(root, base, head) };
}
function reader(
    change?: (name: string, args: Record<string, unknown>, result: unknown) => unknown,
): PublishedReader & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let skill = structuredClone(reviewer);
    return {
        calls,
        async read(name, args) {
            calls.push({ name, args });
            let result: unknown;
            if (name === 'get_skill' && !args.includeAssessment) result = structuredClone(reviewer);
            else if (name === 'get_context') result = structuredClone(contexts.find((c) => c.nodeId === args.nodeId));
            else {
                result = {
                    reviewerId,
                    publicationVersion: reviewer.version,
                    selectionsHash: digest(selections),
                    scopeIdentity: digest({
                        reviewerId,
                        publicationVersion: reviewer.version,
                        selectionsHash: digest(selections),
                        entries,
                        gaps: [],
                    }),
                    complete: true,
                    totalMatched: entries.length,
                    offset: 0,
                    nextOffset: null,
                    entries: structuredClone(entries),
                    gaps: [],
                } satisfies ScopePage;
            }
            const changed = change ? change(name, args, result) : result;
            if (name === 'get_skill' && !args.includeAssessment) skill = structuredClone(changed as Publication);
            return args.includeAssessment ? { ...skill, assessment: changed } : changed;
        },
    };
}
function run(repo: ReturnType<typeof repository>, source: PublishedReader = reader(), capture = false) {
    return prepareReview({
        repository: repo.root,
        base: repo.base,
        head: 'test',
        reviewerId,
        reader: source,
        ...(capture ? {} : { artifact: repo.artifact }),
    });
}

describe('deterministic preparation', () => {
    it('enumerates once, pins original material and preserves all not-evaluated slots and overlap reasons', async () => {
        const repo = repository();
        const source = reader();
        const { state, statePath, materialPath } = await run(repo, source);
        expect(state.preparationStatus).toBe('prepared');
        expect(state.reviewStatus).toBe('not_started');
        expect(state.expectedContextCount).toBe(3);
        expect(state.entries).toHaveLength(3);
        expect(state.entries[0]!.reasons).toEqual(['contextIds[0]', 'domains[0]']);
        expect(state.entries[2]!.reasons).toEqual([`requires:${ids[1]}@2`]);
        expect(
            state.entries.every(
                (entry) =>
                    entry.result.disposition === 'not_evaluated' &&
                    entry.result.adherence === null &&
                    entry.result.confidence === null,
            ),
        ).toBe(true);
        expect(source.calls.filter((c) => c.args.includeAssessment)).toHaveLength(1);
        expect(source.calls.filter((c) => c.name === 'get_context').map((c) => c.args.publicationVersion)).toEqual([
            1, 2, 3,
        ]);
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(state);
        expect(Object.values(JSON.parse(readFileSync(materialPath, 'utf8')))).toEqual(contexts);
    });
    it('fixes branch and tree identities before MCP reads despite later branch/index/working-tree changes', async () => {
        const repo = repository();
        let moved = false;
        const result = await run(
            repo,
            reader((_name, _args, result) => {
                if (!moved) {
                    repo.git('update-ref', 'refs/heads/test', repo.base);
                    writeFileSync(join(repo.root, 'file.txt'), 'dirty');
                    repo.git('add', 'file.txt');
                    moved = true;
                }
                return result;
            }),
            true,
        );
        expect(result.state.artifact.head.commit).toBe(repo.head);
        expect(result.state.artifact.base.commit).toBe(repo.base);
        expect(result.state.artifact.head.tree).toBe(repo.git('rev-parse', `${repo.head}^{tree}`));
    });
    it('preserves earlier runs and stable assessment IDs on repeat preparation', async () => {
        const repo = repository();
        const first = await run(repo);
        const original = readFileSync(first.statePath, 'utf8');
        const second = await run(repo);
        expect(second.state.runId).not.toBe(first.state.runId);
        expect(readFileSync(first.statePath, 'utf8')).toBe(original);
        expect(second.state.entries.map((e) => e.assessmentId)).toEqual(first.state.entries.map((e) => e.assessmentId));
        expect(readdirSync(join(repo.root, '.contextrail/reviewer'))).toHaveLength(2);
    });
    it.each(['mcp_read_rejected', 'publication_changed', 'mcp_read_failed'])(
        'retains an expected slot when content retrieval fails: %s',
        async (code) => {
            const { state } = await run(
                repository(),
                reader((name, args, result) => {
                    if (name === 'get_context' && args.nodeId === ids[1]) throw new PreparationReadError(code);
                    return result;
                }),
            );
            expect(state.preparationStatus).toBe('incomplete');
            expect(state.entries).toHaveLength(3);
            expect(state.entries[1]!.material).toBeNull();
            expect(state.gaps).toContainEqual({ code, reason: ids[1] });
        },
    );
    it('retains unknown versions for unavailable expected contexts without inventing metadata', async () => {
        const { state } = await run(
            repository(),
            reader((_name, args, result) => {
                if (!args.includeAssessment) return result;
                const page = result as ScopePage;
                page.entries = page.entries.map((e) =>
                    e.nodeId === ids[1] ? { ...e, version: null, subtype: null, contentHash: null } : e,
                );
                page.complete = false;
                page.gaps = [{ code: 'context_unavailable', reason: ids[1]! }];
                page.scopeIdentity = digest({
                    reviewerId: page.reviewerId,
                    publicationVersion: page.publicationVersion,
                    selectionsHash: page.selectionsHash,
                    entries: page.entries,
                    gaps: page.gaps,
                });
                return page;
            }),
        );
        expect(state.preparationStatus).toBe('incomplete');
        expect(state.entries[1]!.version).toBeNull();
        expect(state.entries[1]!.result.disposition).toBe('not_evaluated');
    });
    it.each(['truncated', 'duplicate', 'count_changed', 'identity_changed', 'malformed'])(
        'rejects %s scope and preserves expected count',
        async (scenario) => {
            const { state } = await run(
                repository(),
                reader((name, args, result) => {
                    if (!args.includeAssessment) return result;
                    const page = result as ScopePage;
                    if (scenario === 'truncated') page.entries.pop();
                    if (scenario === 'duplicate') page.entries[1] = entries[0]!;
                    if (scenario === 'count_changed') page.totalMatched++;
                    if (scenario === 'identity_changed') page.scopeIdentity = digest('changed');
                    if (scenario === 'malformed') return { ...page, entries: 'invalid' };
                    return page;
                }),
            );
            expect(state.preparationStatus).toBe('incomplete');
            expect(state.gaps.length).toBeGreaterThan(0);
            if (scenario !== 'malformed') expect(state.expectedContextCount).toBe(scenario === 'count_changed' ? 4 : 3);
        },
    );
    it('detects reviewer drift after hydration', async () => {
        const { state } = await run(
            repository(),
            reader((name, args, result) => {
                if (name === 'get_skill' && !args.includeAssessment && args.publicationVersion)
                    return { ...(result as Publication), version: 5 };
                return result;
            }),
        );
        expect(state.preparationStatus).toBe('incomplete');
        expect(state.reviewer!.version).toBe(4);
    });
    it('rejects changed original context content even if the version is unchanged', async () => {
        const { state } = await run(
            repository(),
            reader((name, _args, result) =>
                name === 'get_context'
                    ? { ...(result as Publication), content: { kind: 'context', body: 'mutated' } }
                    : result,
            ),
        );
        expect(state.preparationStatus).toBe('incomplete');
        expect(state.entries.every((e) => e.material === null)).toBe(true);
    });
    it('explains an instruction-only reviewer without inventing assessment criteria', async () => {
        const source = reader();
        const manifest = {
            reviewerId,
            publicationVersion: reviewer.version,
            selectionsHash: digest({ contextIds: [], domains: [] }),
            scopeIdentity: '',
            complete: false,
            totalMatched: 0,
            offset: 0,
            nextOffset: null,
            entries: [],
            gaps: [{ code: 'preparation_not_configured', reason: 'reviewer.selections' }],
        };
        manifest.scopeIdentity = digest({
            reviewerId,
            publicationVersion: reviewer.version,
            selectionsHash: manifest.selectionsHash,
            entries: [],
            gaps: manifest.gaps,
        });
        const { state } = await run(repository(), {
            async read(name, args) {
                if (args.includeAssessment)
                    return {
                        ...reviewer,
                        content: { ...reviewer.content, reviewer: { selections: { contextIds: [], domains: [] } } },
                        assessment: manifest,
                    };
                return name === 'get_skill'
                    ? {
                          ...reviewer,
                          content: { ...reviewer.content, reviewer: { selections: { contextIds: [], domains: [] } } },
                      }
                    : source.read(name, args);
            },
        });
        expect(state.preparationStatus).toBe('not_configured');
        expect(state.entries).toEqual([]);
    });
    it('does not persist arbitrary server errors or credentials', async () => {
        const { state } = await run(
            repository(),
            reader(() => {
                throw new Error('private-title Authorization Bearer secret');
            }),
        );
        expect(state.preparationStatus).toBe('incomplete');
        expect(JSON.stringify(state)).not.toContain('secret');
    });
    it('reports nested SCP remotes without disclosing credentials or paths', () => {
        const repo = repository();
        repo.git('remote', 'add', 'origin', 'git@gitlab.example:group/nested/repo.git');
        expect(fixGitIdentity(repo.root, repo.base, repo.head).repositoryEnvironment).toEqual({
            status: 'reported',
            provider: 'gitlab.example',
            owner: 'group/nested',
            name: 'repo',
        });
    });
});

describe('durable incomplete preparation', () => {
    it('checkpoints initial identity and all expected entries before hydration, then retains progress on cancellation', async () => {
        const repo = repository();
        let calls = 0;
        let observedInitial = false;
        let interruptedState: unknown;
        const source = reader((name, _args, result) => {
            const runDirectory = join(
                repo.root,
                '.contextrail/reviewer',
                readdirSync(join(repo.root, '.contextrail/reviewer'))[0]!,
            );
            const current = JSON.parse(readFileSync(join(runDirectory, 'state.json'), 'utf8'));
            if (!observedInitial) {
                observedInitial = true;
                expect(current).toMatchObject({
                    preparationStatus: 'incomplete',
                    expectedContextCount: null,
                    reviewer: null,
                    artifact: { head: { commit: repo.head } },
                });
            }
            if (name === 'get_context' && ++calls === 2) {
                expect(current.expectedContextCount).toBe(3);
                expect(current.entries).toHaveLength(3);
                expect(current.entries.filter((e: { material: string | null }) => e.material)).toHaveLength(1);
                const materials = JSON.parse(readFileSync(join(runDirectory, 'publications.json'), 'utf8'));
                expect(materials[current.entries[0].assessmentId]).toMatchObject({ nodeId: ids[0], version: 1 });
                expect(current.preparationStatus).toBe('incomplete');
                interruptedState = current;
                throw new PreparationReadError('mcp_cancelled', { phase: 'read' });
            }
            return result;
        });
        const { state } = await run(repo, source);
        expect(interruptedState).toBeDefined();
        expect(calls).toBe(2);
        expect(state.preparationStatus).toBe('incomplete');
        expect(state.entries.filter((e) => e.material)).toHaveLength(1);
        expect(
            state.entries.every(
                (e) =>
                    e.result.disposition === 'not_evaluated' &&
                    e.result.adherence === null &&
                    e.result.confidence === null,
            ),
        ).toBe(true);
        expect(state.gaps).toContainEqual({ code: 'mcp_cancelled', reason: ids[1], diagnostic: { phase: 'read' } });
        console.log(
            'C1 interruption evidence',
            JSON.stringify({
                expected: state.expectedContextCount,
                persisted: 1,
                contentReads: calls,
                preparationStatus: state.preparationStatus,
                reviewStatus: state.reviewStatus,
                gaps: state.gaps,
            }),
        );
    });
    it('preserves an oversized/incomplete response reason and known count without accepting false identity', async () => {
        const { state } = await run(
            repository(),
            reader((_name, args, result) =>
                args.includeAssessment
                    ? {
                          ...(result as ScopePage),
                          complete: false,
                          entries: [],
                          gaps: [{ code: 'scope_over_limit', reason: 'Provider response boundary' }],
                      }
                    : result,
            ),
        );
        expect(state.preparationStatus).toBe('incomplete');
        expect(state.expectedContextCount).toBe(3);
        expect(state.gaps).toContainEqual({ code: 'scope_over_limit', reason: 'Provider response boundary' });
        expect(state.gaps.some((g) => g.code === 'scope_changed_or_invalid')).toBe(false);
        const wrong = await run(
            repository(),
            reader((_name, args, result) =>
                args.includeAssessment
                    ? {
                          ...(result as ScopePage),
                          selectionsHash: digest('wrong'),
                          complete: false,
                          gaps: [{ code: 'scope_over_limit', reason: 'Provider response boundary' }],
                      }
                    : result,
            ),
        );
        expect(wrong.state.gaps.map((g) => g.code)).toEqual(['scope_over_limit', 'scope_changed_or_invalid']);
    });
});
