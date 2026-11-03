import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

/** Only caller-authored synthetic files and publications enter the reviewed comparison. */
export async function prepareSemanticCase(fixture, { prepareReview, digest, root }) {
    const directory = root ?? mkdtempSync(join(tmpdir(), 'governed-semantic-'));
    const repository = join(directory, 'repository');
    mkdirSync(repository, { recursive: true, mode: 0o700 });
    const git = (...args) =>
        execFileSync(
            'git',
            [
                '-c',
                'core.hooksPath=/dev/null',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'commit.gpgsign=false',
                '-c',
                'user.name=Synthetic fixture',
                '-c',
                'user.email=fixture@example.invalid',
                '-C',
                repository,
                ...args,
            ],
            {
                encoding: 'utf8',
                env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
            },
        ).trim();
    const writeFiles = (files) => {
        for (const [path, content] of Object.entries(files)) {
            if (!/^[A-Za-z0-9._/-]+$/u.test(path) || path.split('/').includes('..') || path.startsWith('/'))
                throw new Error('invalid_synthetic_fixture_path');
            mkdirSync(dirname(join(repository, path)), { recursive: true });
            writeFileSync(join(repository, path), content, { mode: 0o600 });
        }
    };
    git('init', '-q');
    writeFiles(fixture.before);
    git('add', '.');
    git('commit', '-qm', 'Synthetic baseline');
    const base = git('rev-parse', 'HEAD');
    writeFiles(fixture.after);
    git('add', '.');
    git('commit', '-qm', 'Synthetic comparison');
    const head = git('rev-parse', 'HEAD');
    const context = {
        nodeId: fixture.contextId,
        version: 1,
        title: fixture.title,
        type: 'context',
        subtype: 'standard',
        domainId: 'fixture',
        status: 'published',
        detailLevel: 'full',
        relationships: [],
        content: { kind: 'context', body: fixture.rule },
    };
    const reviewer = {
        nodeId: 'skill://fixture/governed-review',
        version: 1,
        title: 'Governed assessment',
        type: 'skill',
        subtype: 'reviewer',
        domainId: 'fixture',
        status: 'published',
        detailLevel: 'full',
        relationships: [],
        content: {
            kind: 'skill',
            instructions:
                'Assess the changed operation against every supplied pinned context. Investigate changed and supporting code, compare base and head, and independently verify applicability, adherence, findings and permitted alternatives. Report exact evidence and limitations. Missing evidence is not a violation. No execution or external guidance discovery is available.',
            reviewer: { selections: { contextIds: [context.nodeId] } },
        },
    };
    const scope = {
        reviewerId: reviewer.nodeId,
        publicationVersion: reviewer.version,
        selectionsHash: digest(reviewer.content.reviewer.selections),
        entries: [
            {
                nodeId: context.nodeId,
                version: context.version,
                subtype: context.subtype,
                reasons: ['selection'],
                contentHash: digest(context.content),
            },
        ],
        gaps: [],
    };
    const reader = {
        async read(name, args) {
            if (name === 'get_context') return context;
            return args.includeAssessment
                ? {
                      ...reviewer,
                      assessment: {
                          ...scope,
                          scopeIdentity: digest(scope),
                          complete: true,
                          totalMatched: 1,
                          offset: 0,
                          nextOffset: null,
                      },
                  }
                : reviewer;
        },
    };
    const prepared = await prepareReview({ repository, base, head, reviewerId: reviewer.nodeId, reader });
    return { directory, repository, prepared };
}
