import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Execution, ExecutionRepository } from '../shared/runner/contract';
import { AgentOutcome, AgentRunner } from './agentRun';
import { ExecutionEngine } from './engine';
import { FakeFeature1 } from './fakeFeature1';
import { Git } from './git';
import { Layout } from './layout';
import { PullRequests, PullRequestTarget } from './prs';
import { PullRequestRecord } from './prs';
import { Redactor } from './redact';
import { ExecutionStore, freshCheckpoint } from './store';
import { Verifier } from './verify';
import { ScriptedRunner } from './exec';

/**
 * A worker with nothing real behind it.
 *
 * No agent is started, no remote is contacted, no pull request is opened
 * and no credit is spent. The one thing that is not a toy is the server:
 * `FakeFeature1` re-implements the rules Feature1 actually enforces, so a
 * test passing here means the worker satisfied the real validation rather
 * than a convenient version of it.
 */

const SHA = (seed: string): string => seed.repeat(40).slice(0, 40);

export class FakeGit {
  /** repositoryId → what the agent "changed" in it. */
  changes = new Map<string, string[]>();
  unclonable = new Set<string>();
  pushes: Array<{ dir: string; branch: string; base: string }> = [];
  failPush = new Set<string>();
  private commitCounter = 0;
  readonly base = SHA('a');

  constructor(private readonly layout: Layout) {}

  async baseCommit(_tenantId: string, repo: ExecutionRepository): Promise<string> {
    if (this.unclonable.has(repo.id)) throw new Error(`could not read from remote ${repo.name}`);
    return this.base;
  }

  async prepareWorktree(
    tenantId: string,
    executionId: string,
    repo: ExecutionRepository
  ): Promise<string> {
    if (this.unclonable.has(repo.id)) throw new Error(`could not read from remote ${repo.name}`);
    const dir = this.layout.worktreeDir(tenantId, executionId, repo.id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private idOf(dir: string): string {
    return path.basename(dir);
  }

  async changedPaths(dir: string): Promise<string[]> {
    return this.changes.get(this.idOf(dir)) ?? [];
  }

  async commit(dir: string, _message: string, paths: string[]): Promise<string | null> {
    if (paths.length === 0) return null;
    this.changes.set(this.idOf(dir), []);
    return SHA(String(++this.commitCounter % 10));
  }

  async headCommit(_dir: string): Promise<string> {
    return SHA(String(this.commitCounter % 10 || 1));
  }

  async commitsSince(dir: string): Promise<Array<{ sha: string; subject: string }>> {
    return [{ sha: SHA('b'), subject: `work in ${this.idOf(dir)}` }];
  }

  async push(dir: string, branch: string, base: string): Promise<void> {
    if (this.failPush.has(this.idOf(dir))) throw new Error('remote rejected the push');
    this.pushes.push({ dir, branch, base });
  }

  async originUrl(dir: string): Promise<string> {
    return `https://github.com/acme/${this.idOf(dir).slice(0, 8)}.git`;
  }
}

export class FakePullRequests {
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
  outcomes: Array<Partial<AgentOutcome>> = [{}];
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
  checkpoint: (execution: Execution) => ReturnType<typeof freshCheckpoint>;
  prBelongsElsewhereOnFirstPr: () => void;
  claim: (execution: Execution) => Promise<Execution>;
  now: () => number;
  setNow: (iso: string) => void;
  cleanup: () => void;
}

export function makeHarness(opts: { nowIso?: string } = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-harness-'));
  let clock = Date.parse(opts.nowIso ?? '2026-10-22T11:00:00.000Z');
  const now = () => clock;

  const layout = new Layout(root);
  const store = new ExecutionStore(layout);
  const transport = new FakeFeature1({ now });
  const git = new FakeGit(layout);
  const prs = new FakePullRequests();
  const agent = new FakeAgent();
  const redactor = new Redactor();
  // Every discovered or named check passes unless a test says otherwise:
  // Feature1 refuses a result that is not green, so a passing check is the
  // ordinary case the fixtures have to produce.
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
    now: () => new Date(clock),
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
    checkpoint: (execution) => freshCheckpoint(execution, new Date(clock)),
    /** Offer the execution and take it, as the worker would. */
    claim: async (execution) => {
      transport.offer(execution);
      const claimed = await transport.claim();
      if (!claimed) throw new Error('the fake offered nothing');
      return claimed;
    },
    /** Make the server refuse the first pull request, as a wrong repo would. */
    prBelongsElsewhereOnFirstPr: () => {
      const original = prs.ensure.bind(prs);
      prs.ensure = async (target: PullRequestTarget) => {
        const record = await original(target);
        transport.prBelongsElsewhere.add(record.url);
        return record;
      };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Say the agent changed something, and give each repository a check that
 * passes — without one, Feature1 refuses the result, which is correct and
 * not what most of these tests are about.
 */
export function agentChanges(harness: Harness, ...repositoryIds: string[]): void {
  for (const repositoryId of repositoryIds) {
    harness.git.changes.set(repositoryId, [`src/${repositoryId}.ts`]);
  }
}

/** A checkout with a package.json, so verification discovers a command. */
export function withDiscoverableTests(
  harness: Harness,
  execution: Execution,
  ...repositoryIds: string[]
): void {
  for (const repositoryId of repositoryIds) {
    const dir = harness.layout.worktreeDir(execution.tenant_id, execution.id, repositoryId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } })
    );
  }
}
