import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, type GitIdentity } from '../src/prepare.js';
import { EvidenceLedger } from '../src/evidence.js';
import { loadReviewCheckpoint } from '../src/resume.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'review-resume-'));
    directories.push(directory);
    const artifact: GitIdentity = {
        kind: 'git_comparison',
        repository: directory,
        repositoryEnvironment: { status: 'unavailable', reason: 'no_remote' },
        base: { suppliedRef: 'base', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
        head: { suppliedRef: 'head', commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
        limitations: [],
    };
    const reviewerId = 'skill://engineering/reviewer';
    const runId = randomUUID();
    const ledger = new EvidenceLedger();
    ledger.add('fixed supporting source', { kind: 'source', path: 'code.ts' });
    const state = {
        schemaVersion: 2,
        runId,
        createdAt: new Date().toISOString(),
        preparationStatus: 'prepared',
        reviewStatus: 'incomplete',
        artifact,
        reviewer: null,
        requestedReviewerId: reviewerId,
        scopeIdentity: digest('scope'),
        expectedContextCount: 0,
        entries: [],
        gaps: [],
        limitations: [],
        changes: { items: [] },
        phases: [],
        findings: [],
        checks: [],
        verification: { complete: false, expected: 0, verified: 0 },
    };
    const write = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value));
    write('state.json', state);
    write('publications.json', {});
    write('evidence.json', ledger.records);
    const manifest = {
        contractVersion: 1,
        runId,
        artifact,
        reviewer: null,
        scopeIdentity: state.scopeIdentity,
        entries: [],
        publicationsHash: digest({}),
        diffHash: digest(null),
        changesHash: digest(state.changes),
        files: Object.fromEntries(
            ['state.json', 'publications.json', 'evidence.json'].map((name) => [
                name,
                `sha256:${createHash('sha256')
                    .update(readFileSync(join(directory, name)))
                    .digest('hex')}`,
            ]),
        ),
    };
    write('manifest.json', manifest);
    return { directory, expected: { artifact, reviewerId }, write, state, manifest };
}
describe('sealed review checkpoints', () => {
    it('restores the original preparation and validated evidence without fetching publications', () => {
        const f = fixture();
        const loaded = loadReviewCheckpoint(f.directory, f.expected);
        expect(loaded.prepared.state.reviewStatus).toBe('not_started');
        expect(loaded.checkpoint.state.runId).toBe(f.state.runId);
        expect(Object.values(loaded.checkpoint.evidence)[0]?.text).toBe('fixed supporting source');
        expect(loaded.checkpoint.preparationManifest).not.toHaveProperty('files');
    });
    it('rejects a different comparison before reuse', () => {
        const f = fixture();
        f.expected.artifact.head.commit = 'e'.repeat(40);
        expect(() => loadReviewCheckpoint(f.directory, f.expected)).toThrow('resume_comparison_changed');
    });
    it('rejects changed evidence and an unsealed checkpoint', () => {
        const f = fixture();
        f.write('evidence.json', {});
        expect(() => loadReviewCheckpoint(f.directory, f.expected)).toThrow();
        rmSync(join(f.directory, 'manifest.json'));
        expect(() => loadReviewCheckpoint(f.directory, f.expected)).toThrow();
    });
    it('never reruns a completed review as a resume', () => {
        const f = fixture();
        f.write('state.json', { ...f.state, reviewStatus: 'complete' });
        expect(() => loadReviewCheckpoint(f.directory, f.expected)).toThrow('resume_requires_incomplete_prepared_run');
    });
});
