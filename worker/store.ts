import * as fs from 'node:fs';
import * as path from 'node:path';
import { Execution, ExecutionState, RepositoryOutcome } from '../shared/runner/contract';
import { CommitRecord } from './git';
import { Layout } from './layout';

/**
 * What a worker must still know after it is killed mid-execution.
 *
 * Written to disk at every point where losing it would cost real work or,
 * worse, duplicate it: a branch that was pushed, a pull request that was
 * opened, a report that was accepted. A worker that forgets it opened a pull
 * request opens a second one, and nothing in GitHub stops it.
 */

/** What the worker knows about one repository, and keeps knowing. */
export interface RepositoryCheckpoint {
  repositoryId: string;
  /** The worktree exists and is on the execution branch. */
  prepared: boolean;
  /** The sha the base branch was on when this execution started. */
  baseCommit: string | null;
  headCommit: string | null;
  changed: boolean;
  pushed: boolean;
  commits: CommitRecord[];
  /** The pull request, recorded the moment it exists. */
  pullRequestUrl: string | null;
  /**
   * Everything that ran here, pass or fail, with the reason a check could
   * not run. Richer than what Feature1 accepts — it only takes passing
   * commands — and it is what the pull request body is written from.
   */
  checks: Array<{
    command: string;
    name: string;
    outcome: 'passed' | 'failed' | 'skipped' | 'unavailable';
    exitCode: number | null;
    reason?: string;
  }>;
  outcome: RepositoryOutcome | null;
  /** Accepted by Feature1, so a resumed attempt does not re-send it. */
  reported: boolean;
  /** Why this repository did not finish. The others still report. */
  error?: string;
}

export interface ExecutionCheckpoint {
  version: 2;
  execution: Execution;
  state: ExecutionState;
  /** Set once a terminal state has been accepted by Feature1. */
  reported: boolean;
  /** Stories already built, by id, so a resumed run does not redo them. */
  completedUnits: string[];
  repositories: RepositoryCheckpoint[];
  startedAt: string;
  updatedAt: string;
  /** Last thing said to Feature1, so a resume does not repeat it. */
  lastMessage?: string;
}

export function freshCheckpoint(execution: Execution, now = new Date()): ExecutionCheckpoint {
  return {
    version: 2,
    execution,
    state: execution.state,
    reported: false,
    completedUnits: [],
    repositories: execution.repositories.map((repo) => ({
      repositoryId: repo.id,
      prepared: false,
      baseCommit: null,
      headCommit: null,
      changed: false,
      pushed: false,
      commits: [],
      pullRequestUrl: null,
      checks: [],
      outcome: null,
      // Results Feature1 already holds from an earlier attempt survive a
      // reclaim, and re-sending one would be a second attach.
      reported: Boolean(execution.results?.[repo.id]),
    })),
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export class ExecutionStore {
  constructor(private readonly layout: Layout) {}

  private fileFor(checkpoint: ExecutionCheckpoint): string {
    return this.layout.checkpointFile(checkpoint.execution.tenant_id, checkpoint.execution.id);
  }

  /**
   * Write so that a crash leaves either the old file or the new one.
   *
   * Temp file in the same directory, then rename — a rename within one
   * filesystem is atomic, so there is no window in which the checkpoint is
   * half-written. A half-written checkpoint is unparseable, and an
   * unparseable checkpoint looks exactly like no checkpoint, which is how a
   * resumable execution becomes a second attempt.
   */
  save(checkpoint: ExecutionCheckpoint, now = new Date()): void {
    const file = this.fileFor(checkpoint);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = { ...checkpoint, updatedAt: now.toISOString() };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temp, file);
  }

  load(tenantId: string, executionId: string): ExecutionCheckpoint | null {
    const file = this.layout.checkpointFile(tenantId, executionId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ExecutionCheckpoint;
      // A checkpoint from a version that is not this one is not understood,
      // and guessing at it would be worse than starting again.
      return parsed?.version === 2 ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Every execution on disk that has not been reported.
   *
   * The restart sweep: these are the ones that were in flight when the worker
   * stopped, and each has to be resumed or given back rather than left.
   */
  unfinished(): ExecutionCheckpoint[] {
    const root = this.layout.executionsRoot();
    const out: ExecutionCheckpoint[] = [];
    let tenants: string[];
    try {
      tenants = fs.readdirSync(root);
    } catch {
      return out;
    }
    for (const tenantId of tenants) {
      let executions: string[];
      try {
        executions = fs.readdirSync(path.join(root, tenantId));
      } catch {
        continue;
      }
      for (const executionId of executions) {
        const checkpoint = this.load(tenantId, executionId);
        if (checkpoint && !checkpoint.reported) out.push(checkpoint);
      }
    }
    return out;
  }

  repository(checkpoint: ExecutionCheckpoint, repositoryId: string): RepositoryCheckpoint {
    const row = checkpoint.repositories.find((r) => r.repositoryId === repositoryId);
    if (!row) throw new Error(`No checkpoint for repository ${repositoryId}`);
    return row;
  }
}
