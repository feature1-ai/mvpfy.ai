import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StaleAttemptError } from '../shared/runner/contract';
import { featureAssignment, sameBasenameAssignment } from '../shared/runner/fixtures';
import { Layout, executionBranch } from './layout';
import { ExecutionStore, freshCheckpoint } from './store';
import { LeaseGuard } from './lease';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-worker-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Layout', () => {
  it('keeps two repositories with the same name apart', () => {
    // The case that breaks anything keyed by basename: both are called `api`.
    const layout = new Layout(root);
    const assignment = sameBasenameAssignment();
    const [a, b] = assignment.repositories;
    expect(a.name).toBe(b.name);
    const first = layout.worktreeDir('acme', 'exec-same-1', a.repositoryId);
    const second = layout.worktreeDir('acme', 'exec-same-1', b.repositoryId);
    expect(first).not.toBe(second);
    expect(layout.cloneDir('acme', a.repositoryId)).not.toBe(
      layout.cloneDir('acme', b.repositoryId)
    );
  });

  it('keys every path by tenant, execution and repository id', () => {
    const layout = new Layout(root);
    const dir = layout.worktreeDir('acme', 'exec-1', 'repo-api');
    expect(dir).toBe(path.join(root, 'executions', 'acme', 'exec-1', 'repos', 'repo-api'));
  });

  it('refuses an id that would climb out of the root', () => {
    const layout = new Layout(root);
    for (const bad of ['../..', 'a/b', '.ssh']) {
      expect(() => layout.worktreeDir('acme', 'exec-1', bad)).toThrow(/not usable in a path/);
      expect(() => layout.executionDir(bad, 'exec-1')).toThrow(/not usable in a path/);
    }
  });

  it('knows what is inside it, for anything about to be removed', () => {
    const layout = new Layout(root);
    expect(layout.contains(layout.worktreeDir('acme', 'e', 'repo-api'))).toBe(true);
    expect(layout.contains('/etc')).toBe(false);
    expect(layout.contains(`${root}-sibling/thing`)).toBe(false);
  });

  it('insists on an absolute root', () => {
    expect(() => new Layout('relative/path')).toThrow(/absolute/);
  });

  it('gives an execution one stable branch, so a revision reuses it', () => {
    expect(executionBranch('exec-1')).toBe('mvpfy/exec-1');
    expect(executionBranch('exec-1')).toBe(executionBranch('exec-1'));
  });
});

describe('ExecutionStore', () => {
  it('writes and reads a checkpoint back', () => {
    const store = new ExecutionStore(new Layout(root));
    const checkpoint = freshCheckpoint(featureAssignment());
    store.save(checkpoint);
    const loaded = store.load('acme', 'exec-feature-1');
    expect(loaded?.assignment.executionId).toBe('exec-feature-1');
    expect(loaded?.repositories.map((r) => r.repositoryId)).toEqual(['repo-api', 'repo-web']);
  });

  it('leaves the old checkpoint intact if the write never finishes', () => {
    // Written to a temp file and renamed, so there is no moment at which the
    // checkpoint on disk is half a document.
    const layout = new Layout(root);
    const store = new ExecutionStore(layout);
    const checkpoint = freshCheckpoint(featureAssignment());
    store.save(checkpoint);
    const file = layout.checkpointFile('acme', 'exec-feature-1');
    const before = fs.readFileSync(file, 'utf8');
    // A crash leaves a .tmp behind; the real file is untouched.
    fs.writeFileSync(`${file}.999.tmp`, '{ "half', 'utf8');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(store.load('acme', 'exec-feature-1')).not.toBeNull();
  });

  it('treats an unreadable checkpoint as absent rather than crashing', () => {
    const layout = new Layout(root);
    const store = new ExecutionStore(layout);
    const file = layout.checkpointFile('acme', 'exec-feature-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all', 'utf8');
    expect(store.load('acme', 'exec-feature-1')).toBeNull();
  });

  it('ignores a checkpoint written by a version it does not understand', () => {
    const layout = new Layout(root);
    const store = new ExecutionStore(layout);
    const file = layout.checkpointFile('acme', 'exec-feature-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99 }), 'utf8');
    expect(store.load('acme', 'exec-feature-1')).toBeNull();
  });

  it('finds the executions that were in flight when the worker stopped', () => {
    const store = new ExecutionStore(new Layout(root));
    const running = freshCheckpoint(featureAssignment());
    const finished = freshCheckpoint(
      featureAssignment({ executionId: 'exec-done', assignmentId: 'asg-done' })
    );
    finished.reported = true;
    store.save(running);
    store.save(finished);
    const unfinished = store.unfinished();
    expect(unfinished.map((c) => c.assignment.executionId)).toEqual(['exec-feature-1']);
  });

  it('has nothing to recover on a fresh machine', () => {
    expect(new ExecutionStore(new Layout(root)).unfinished()).toEqual([]);
  });
});

describe('LeaseGuard', () => {
  const at = (iso: string) => Date.parse(iso);

  it('allows work while the lease holds', () => {
    let now = at('2026-10-21T11:00:00Z');
    const lease = new LeaseGuard('asg-1', 'token-1', '2026-10-21T12:00:00Z', () => now);
    expect(lease.live).toBe(true);
    expect(() => lease.assertLive('pushing')).not.toThrow();
    now = at('2026-10-21T12:00:01Z');
    expect(lease.live).toBe(false);
  });

  it('refuses to publish once the lease has gone, naming the step', () => {
    // The dangerous moment is publishing, not working — so the message says
    // what was not done.
    const lease = new LeaseGuard('asg-1', 'token-1', '2026-10-21T10:00:00Z', () =>
      at('2026-10-21T11:00:00Z')
    );
    expect(() => lease.assertLive('opening the pull request')).toThrow(StaleAttemptError);
    expect(() => lease.assertLive('opening the pull request')).toThrow(/opening the pull request/);
  });

  it('refuses after it has been given up, even if time remains', () => {
    const lease = new LeaseGuard('asg-1', 'token-1', '2026-10-21T12:00:00Z', () =>
      at('2026-10-21T11:00:00Z')
    );
    lease.surrender();
    expect(lease.live).toBe(false);
    expect(() => lease.assertLive('reporting')).toThrow(/gave up/);
  });

  it('never shortens a lease when a stale renewal arrives late', () => {
    const now = at('2026-10-21T11:00:00Z');
    const lease = new LeaseGuard('asg-1', 'token-1', '2026-10-21T12:00:00Z', () => now);
    lease.renew('2026-10-21T11:30:00Z');
    expect(lease.remainingMs).toBe(at('2026-10-21T12:00:00Z') - now);
    lease.renew('2026-10-21T13:00:00Z');
    expect(lease.remainingMs).toBe(at('2026-10-21T13:00:00Z') - now);
  });

  it('refuses a lease expiry that is not a date', () => {
    expect(() => new LeaseGuard('a', 't', 'soon')).toThrow(/not a date/);
  });
});
