import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IDS, featureExecution, sameNameExecution } from '../shared/runner/fixtures';
import { Layout, executionBranch } from './layout';
import { ExecutionStore, freshCheckpoint } from './store';

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
    const execution = sameNameExecution();
    const [a, b] = execution.repositories;
    expect(a.name).toBe(b.name);
    const first = layout.worktreeDir(IDS.tenant, IDS.execSame, a.id);
    const second = layout.worktreeDir(IDS.tenant, IDS.execSame, b.id);
    expect(first).not.toBe(second);
    expect(layout.cloneDir(IDS.tenant, a.id)).not.toBe(layout.cloneDir(IDS.tenant, b.id));
  });

  it('keys every path by tenant, execution and repository id', () => {
    const layout = new Layout(root);
    const dir = layout.worktreeDir(IDS.tenant, IDS.execFeature, IDS.repoApi);
    expect(dir).toBe(
      path.join(root, 'executions', IDS.tenant, IDS.execFeature, 'repos', IDS.repoApi)
    );
  });

  it('refuses anything that is not a UUID, because these become directories', () => {
    const layout = new Layout(root);
    for (const bad of ['../..', 'a/b', '.ssh', 'repo-api']) {
      expect(() => layout.worktreeDir(IDS.tenant, IDS.execFeature, bad)).toThrow(/not a UUID/);
      expect(() => layout.executionDir(bad, IDS.execFeature)).toThrow(/not a UUID/);
    }
  });

  it('knows what is inside it, for anything about to be removed', () => {
    const layout = new Layout(root);
    expect(layout.contains(layout.worktreeDir(IDS.tenant, IDS.execFeature, IDS.repoApi))).toBe(
      true
    );
    expect(layout.contains('/etc')).toBe(false);
    expect(layout.contains(`${root}-sibling/thing`)).toBe(false);
  });

  it('insists on an absolute root', () => {
    expect(() => new Layout('relative/path')).toThrow(/absolute/);
  });

  it('gives an execution one stable branch, so a retry reuses it', () => {
    expect(executionBranch(IDS.execFeature)).toBe(`mvpfy/${IDS.execFeature}`);
    expect(executionBranch(IDS.execFeature)).toBe(executionBranch(IDS.execFeature));
  });
});

describe('ExecutionStore', () => {
  it('writes and reads a checkpoint back', () => {
    const store = new ExecutionStore(new Layout(root));
    const checkpoint = freshCheckpoint(featureExecution());
    store.save(checkpoint);
    const loaded = store.load(IDS.tenant, IDS.execFeature);
    expect(loaded?.execution.id).toBe(IDS.execFeature);
    expect(loaded?.repositories.map((r) => r.repositoryId)).toEqual([IDS.repoApi, IDS.repoWeb]);
  });

  it('leaves the old checkpoint intact if the write never finishes', () => {
    // Written to a temp file and renamed, so there is no moment at which the
    // checkpoint on disk is half a document.
    const layout = new Layout(root);
    const store = new ExecutionStore(layout);
    const checkpoint = freshCheckpoint(featureExecution());
    store.save(checkpoint);
    const file = layout.checkpointFile(IDS.tenant, IDS.execFeature);
    const before = fs.readFileSync(file, 'utf8');
    // A crash leaves a .tmp behind; the real file is untouched.
    fs.writeFileSync(`${file}.999.tmp`, '{ "half', 'utf8');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(store.load(IDS.tenant, IDS.execFeature)).not.toBeNull();
  });

  it('treats an unreadable checkpoint as absent rather than crashing', () => {
    const layout = new Layout(root);
    const store = new ExecutionStore(layout);
    const file = layout.checkpointFile(IDS.tenant, IDS.execFeature);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all', 'utf8');
    expect(store.load(IDS.tenant, IDS.execFeature)).toBeNull();
  });

  it('ignores a checkpoint written by a version it does not understand', () => {
    const layout = new Layout(root);
    const store = new ExecutionStore(layout);
    const file = layout.checkpointFile(IDS.tenant, IDS.execFeature);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99 }), 'utf8');
    expect(store.load(IDS.tenant, IDS.execFeature)).toBeNull();
  });

  it('finds the executions that were in flight when the worker stopped', () => {
    const store = new ExecutionStore(new Layout(root));
    const running = freshCheckpoint(featureExecution());
    const finished = freshCheckpoint(featureExecution({ id: IDS.execTask }));
    finished.reported = true;
    store.save(running);
    store.save(finished);
    const unfinished = store.unfinished();
    expect(unfinished.map((c) => c.execution.id)).toEqual([IDS.execFeature]);
  });

  it('has nothing to recover on a fresh machine', () => {
    expect(new ExecutionStore(new Layout(root)).unfinished()).toEqual([]);
  });
});
