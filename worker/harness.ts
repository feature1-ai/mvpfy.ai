import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Assignment, PullRequestRecord, RepositoryRef } from '../shared/runner/contract';
import { AgentOutcome, AgentRunner } from './agentRun';
import { ExecutionEngine } from './engine';
import { FakeFeature1 } from './fakeFeature1';
import { Git } from './git';
import { Layout } from './layout';
import { LeaseGuard } from './lease';
import { PullRequests, PullRequestTarget } from './prs';
import { Redactor } from './redact';
import { ExecutionStore, freshCheckpoint } from './store';
import { Verifier } from './verify';
import { ScriptedRunner } from './exec';

/**
 * A worker with nothing real behind it.
 *
 * Every test in this repository runs through here: no agent is started, no
 * remote is contacted, no pull request is opened, and no credit is spent.
 * The fakes are stateful rather than canned, because the behaviour worth
 * testing is what the worker does when its own record and the server's
 * disagree.
 */

export class FakeGit {
  /** repositoryId → what the agent "changed" in it. */
  changes = new Map<string, string[]>();
  /** repositoryIds whose clone will not work. */
  unclonable = new Set<string>();
  pushes: Array<{ dir: string; branch: string; base: string }> = [];
  failPush = new Set<string>();
  private commitCounter = 0;

  constructor(private readonly layout: Layout) {}

  async prepareWorktree(
    tenantId: string,
    executionId: string,
    repo: RepositoryRef
  ): Promise<string> {
    if (this.unclonable.has(repo.repositoryId)) {
      throw new Error(`could not read from remote repository ${repo.name}`);
    }
    const dir = this.layout.worktreeDir(tenantId, executionId, repo.repositoryId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async changedPaths(dir: string): Promise<string[]> {
    const repositoryId = path.basename(dir);
    return this.changes.get(repositoryId) ?? [];
  }

  async commit(dir: string, _message: string, paths: string[]): Promise<string | null> {
    if (paths.length === 0) return null;
    const repositoryId = path.basename(dir);
    // One commit's worth of work is consumed, as a real commit would do.
    this.changes.set(repositoryId, []);
    return `${'0'.repeat(33)}${String(++this.commitCounter).padStart(7, '0')}`;
  }

  async commitsSince(dir: string): Promise<Array<{ sha: string; subject: string }>> {
    const repositoryId = path.basename(dir);
    return [{ sha: 'a'.repeat(40), subject: `work in ${repositoryId}` }];
  }

  async push(dir: string, branch: string, base: string): Promise<void> {
    const repositoryId = path.basename(dir);
    if (this.failPush.has(repositoryId)) throw new Error('remote rejected the push');
    this.pushes.push({ dir, branch, base });
  }

  async originUrl(dir: string): Promise<string> {
    return `https://github.com/acme/${path.basename(dir)}.git`;
  }
}

export class FakePullRequests {
  /** What GitHub holds, keyed by owner/name#headBranch. */
  open = new Map<string, PullRequestRecord>();
  creates: string[] = [];
  failCreateFor = new Set<string>();
  private number = 100;

  private key(t: { owner: string; name: string; headBranch: string }): string {
    return `${t.owner}/${t.name}#${t.headBranch}`;
  }

  async findExisting(target: PullRequestTarget): Promise<PullRequestRecord | null> {
    return this.open.get(this.key(target)) ?? null;
  }

  async ensure(target: PullRequestTarget): Promise<PullRequestRecord> {
    const key = this.key(target);
    const existing = this.open.get(key);
    if (existing) return existing;
    if (this.failCreateFor.has(target.name)) {
      throw new Error(`Could not open a pull request for ${target.owner}/${target.name}`);
    }
    this.creates.push(key);
    const record: PullRequestRecord = {
      url: `https://github.com/${target.owner}/${target.name}/pull/${++this.number}`,
      number: this.number,
      repositoryOwner: target.owner,
      repositoryName: target.name,
      headBranch: target.headBranch,
      baseBranch: target.baseBranch,
      createdByThisAttempt: true,
    };
    this.open.set(key, { ...record, createdByThisAttempt: false });
    return record;
  }
}

export class FakeAgent implements AgentRunner {
  runs: Array<{ prompt: string; cwd: string }> = [];
  /** What each run returns, in order. The last one repeats. */
  outcomes: Array<Partial<AgentOutcome>> = [{}];
  /** Called before each run, so a test can cancel or change the world. */
  onRun?: (index: number) => void;

  async run(input: { prompt: string; cwd: string; signal?: AbortSignal }): Promise<AgentOutcome> {
    const index = this.runs.length;
    this.runs.push({ prompt: input.prompt, cwd: input.cwd });
    this.onRun?.(index);
    const chosen = this.outcomes[Math.min(index, this.outcomes.length - 1)] ?? {};
    return {
      code: 0,
      cancelled: Boolean(input.signal?.aborted),
      timedOut: false,
      questions: [],
      tail: '',
      ...chosen,
    };
  }
}

export interface Harness {
  root: string;
  layout: Layout;
  store: ExecutionStore;
  transport: FakeFeature1;
  git: FakeGit;
  prs: FakePullRequests;
  agent: FakeAgent;
  runner: ScriptedRunner;
  engine: ExecutionEngine;
  lease: (assignment: Assignment, expiresAt?: string) => LeaseGuard;
  checkpoint: (assignment: Assignment) => ReturnType<typeof freshCheckpoint>;
  now: () => number;
  setNow: (iso: string) => void;
  cleanup: () => void;
}

export function makeHarness(opts: { nowIso?: string } = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-harness-'));
  let clock = Date.parse(opts.nowIso ?? '2026-10-21T11:00:00.000Z');
  const now = () => clock;

  const layout = new Layout(root);
  const store = new ExecutionStore(layout);
  const transport = new FakeFeature1();
  const git = new FakeGit(layout);
  const prs = new FakePullRequests();
  const agent = new FakeAgent();
  const redactor = new Redactor();
  const runner = new ScriptedRunner();

  const engine = new ExecutionEngine({
    transport,
    store,
    layout,
    git: git as unknown as Git,
    verifier: new Verifier(runner, redactor),
    pullRequests: prs as unknown as PullRequests,
    agent,
    redactor,
    agentKind: 'claude',
    runnerId: 'runner-1',
    now: () => new Date(clock),
    // Retries are exercised in these tests; waiting out real backoff is not.
    sleep: async () => {},
  });

  return {
    root,
    layout,
    store,
    transport,
    git,
    prs,
    agent,
    runner,
    engine,
    now,
    setNow: (iso: string) => {
      clock = Date.parse(iso);
    },
    lease: (assignment, expiresAt = '2026-10-21T23:00:00.000Z') =>
      new LeaseGuard(assignment.assignmentId, assignment.attemptToken, expiresAt, now),
    checkpoint: (assignment) => {
      // The server knows about work before the worker reports on it, and a
      // fake that does not would reject every write as unknown.
      transport.known(assignment);
      return freshCheckpoint(assignment, new Date(clock));
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Say the agent changed something in each of these repositories. */
export function agentChanges(harness: Harness, ...repositoryIds: string[]): void {
  for (const repositoryId of repositoryIds) {
    harness.git.changes.set(repositoryId, [`src/${repositoryId}.ts`]);
  }
}
