import * as path from 'node:path';
import {
  Execution,
  ExecutionState,
  RepositoryResult,
  STAGES,
  Snapshot,
  StaleAttemptError,
} from '../shared/runner/contract';
import {
  authorisedRepository,
  passingTests,
  repositoryResultProblem,
  unitsOf,
} from '../shared/runner/validate';
import { Feature1Transport, withRetry } from './transport';
import { ExecutionCheckpoint, ExecutionStore, RepositoryCheckpoint } from './store';
import { Layout, executionBranch } from './layout';
import { Git, GitError } from './git';
import { Verifier, VerificationResult, canReport } from './verify';
import { PullRequests, pullRequestBody } from './prs';
import { AgentKind, AgentRunner } from './agentRun';
import { Redactor } from './redact';
import { buildPrompt, commitMessageFor, criterionText } from './prompt';

/**
 * One execution, from a claimed run to a terminal state Feature1 accepted.
 *
 * Three ideas hold it together.
 *
 * **Nothing is believed because an agent said so.** An agent that writes no
 * code exits zero. Feature1 agrees: it accepts commit shas and passing
 * commands, not an account of what happened. So after the agent finishes
 * the worker goes and looks — what changed, what was committed, what the
 * checks returned, whether a pull request already exists.
 *
 * **Every step is a checkpoint.** The worker is killed mid-execution as a
 * matter of routine, and a lease lasts three minutes. Resuming is not an
 * optimisation: an execution that starts over opens a second pull request,
 * and nothing in GitHub stops it.
 *
 * **The lease is checked immediately before every publishing step.** Working
 * past a lost lease wastes time. Publishing past one lets two workers both
 * report on the same execution, and Feature1's 409 is the only thing
 * standing between us and that.
 */

export interface EngineDeps {
  transport: Feature1Transport;
  store: ExecutionStore;
  layout: Layout;
  git: Git;
  verifier: Verifier;
  pullRequests: PullRequests;
  agent: AgentRunner;
  redactor: Redactor;
  agentKind: AgentKind;
  agentModel?: string;
  log?: (message: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Why an execution stopped. What the worker tells Feature1 last. */
export type Ending = 'ready_for_testing' | 'blocked' | 'failed' | 'cancelled';

export class ExecutionEngine {
  private readonly now: () => Date;
  private readonly retry: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Advanced by every successful progress call. Checked before publishing. */
  private leaseUntil = 0;
  private superseded = false;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.retry = (operation) => withRetry(operation, deps.sleep ? { sleep: deps.sleep } : {});
  }

  private log(message: string): void {
    this.deps.log?.(this.deps.redactor.line(message, 500));
  }

  /**
   * Say something to Feature1, and learn three things back: that the lease
   * is still ours, when it now expires, and whether somebody cancelled.
   *
   * Every call goes through here, including the empty ones, because the
   * heartbeat and the progress report are the same request — which means
   * the worker never has to choose between telling Feature1 what it is
   * doing and staying alive.
   */
  private async say(
    checkpoint: ExecutionCheckpoint,
    body: Parameters<Feature1Transport['progress']>[2]
  ): Promise<{ cancelRequested: boolean }> {
    const { execution } = checkpoint;
    const response = await this.retry(() =>
      this.deps.transport.progress(execution.id, execution.lease_token, body)
    );
    const until = Date.parse(response?.lease_until ?? '');
    if (!Number.isNaN(until)) this.leaseUntil = until;
    if (body.state) {
      checkpoint.state = body.state;
      this.deps.store.save(checkpoint, this.now());
    }
    return { cancelRequested: Boolean(response?.cancel_requested) };
  }

  /**
   * Refuse to go on.
   *
   * Called immediately before each publishing step, naming it, so the log
   * says what was not done rather than only that something was not.
   */
  private assertLive(step: string): void {
    if (this.superseded) {
      throw new StaleAttemptError(`${step} stopped: this attempt was superseded`);
    }
    if (this.leaseUntil && this.now().getTime() >= this.leaseUntil) {
      throw new StaleAttemptError(`${step} stopped: the lease expired before it ran`);
    }
  }

  /** A heartbeat, for the loop that keeps the lease alive while work runs. */
  async beat(checkpoint: ExecutionCheckpoint): Promise<{ cancelRequested: boolean }> {
    return this.say(checkpoint, {});
  }

  /**
   * Run it.
   *
   * A `StaleAttemptError` escaping is the one case where nothing is
   * reported: by then this worker has no standing to say anything about the
   * execution, and Feature1 has given it to somebody else.
   */
  async run(checkpoint: ExecutionCheckpoint, signal: AbortSignal): Promise<Ending> {
    const { execution } = checkpoint;
    this.leaseUntil = Date.parse(execution.lease_until ?? '') || 0;
    this.superseded = false;
    try {
      return await this.execute(checkpoint, signal);
    } catch (error) {
      if (error instanceof StaleAttemptError) {
        this.superseded = true;
        this.log(`${execution.id}: ${error.message} — stopping without reporting`);
        this.deps.store.save(checkpoint, this.now());
        throw error;
      }
      const message = this.deps.redactor.line((error as Error).message ?? String(error));
      this.log(`${execution.id} failed: ${message}`);
      return this.finish(checkpoint, 'failed', `The execution stopped: ${message}`);
    }
  }

  private async execute(checkpoint: ExecutionCheckpoint, signal: AbortSignal): Promise<Ending> {
    const { execution } = checkpoint;

    // -- prepare ------------------------------------------------------------
    if (await this.cancelled(checkpoint, 'preparing', 'Setting up the checkouts')) {
      return this.finish(checkpoint, 'cancelled', 'Cancelled before it started');
    }
    const worktrees: Record<string, string> = {};
    for (const repo of execution.repositories) {
      const row = this.deps.store.repository(checkpoint, repo.id);
      if (row.reported) continue; // A previous attempt already finished it.
      try {
        const authorised = authorisedRepository(execution, repo.id);
        row.baseCommit = await this.deps.git.baseCommit(execution.tenant_id, authorised);
        worktrees[repo.id] = await this.deps.git.prepareWorktree(
          execution.tenant_id,
          execution.id,
          authorised
        );
        row.prepared = true;
      } catch (error) {
        row.prepared = false;
        row.error = this.deps.redactor.line(
          error instanceof GitError ? error.failure.message : (error as Error).message
        );
      }
      this.deps.store.save(checkpoint, this.now());
    }
    const outstanding = execution.repositories.filter(
      (r) => !this.deps.store.repository(checkpoint, r.id).reported
    );
    if (outstanding.length > 0 && Object.keys(worktrees).length === 0) {
      return this.blocked(
        checkpoint,
        'None of this execution’s repositories could be cloned. Check the repository URLs ' +
          'and that the worker’s git credentials can read them.'
      );
    }

    // -- implement ----------------------------------------------------------
    const units = unitsOf(execution);
    const questionsFile = path.join(
      this.deps.layout.agentDir(execution.tenant_id, execution.id),
      'mvpfy-questions.md'
    );
    for (const [index, unit] of units.entries()) {
      if (signal.aborted) return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');
      if (checkpoint.completedUnits.includes(unit.id)) continue;
      const label = `${unit.code ?? unit.id} — ${unit.title ?? 'work'}`;
      const cancelled = await this.cancelled(
        checkpoint,
        'implementing',
        `Building ${label} (${index + 1} of ${units.length})`
      );
      if (cancelled) return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');

      const outcome = await this.deps.agent.run({
        kind: this.deps.agentKind,
        ...(this.deps.agentModel ? { model: this.deps.agentModel } : {}),
        prompt: buildPrompt({ execution, worktrees, questionsFile, unit }),
        cwd: this.deps.layout.executionDir(execution.tenant_id, execution.id),
        agentDir: this.deps.layout.agentDir(execution.tenant_id, execution.id),
        questionsFile,
        signal,
      });
      if (outcome.cancelled || signal.aborted) {
        return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');
      }
      if (outcome.questions.length > 0) {
        // Feature1 takes one message, and a person reads it. Numbered, so
        // the answer can address them one at a time.
        return this.blocked(
          checkpoint,
          outcome.questions.map((q, i) => `${i + 1}. ${q}`).join(' ')
        );
      }
      if (outcome.code !== 0) {
        this.log(`${execution.id}: agent exited ${outcome.code} on ${label}`);
      }
      await this.commitUnit(checkpoint, worktrees, unit);
      checkpoint.completedUnits.push(unit.id);
      this.deps.store.save(checkpoint, this.now());
    }

    // -- verify -------------------------------------------------------------
    if (signal.aborted) return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');
    if (await this.cancelled(checkpoint, 'verifying', 'Running the checks')) {
      return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');
    }
    const verification: Record<string, VerificationResult[]> = {};
    for (const repositoryId of Object.keys(worktrees)) {
      const rows = await this.deps.verifier.verifyRepository(repositoryId, { worktrees, signal });
      verification[repositoryId] = rows;
      const row = this.deps.store.repository(checkpoint, repositoryId);
      row.checks = rows.map((r) => ({
        command: r.command,
        name: r.name,
        outcome: r.outcome,
        exitCode: r.exitCode,
        ...(r.reason ? { reason: r.reason } : {}),
      }));
      this.deps.store.save(checkpoint, this.now());
    }

    // -- publish ------------------------------------------------------------
    if (signal.aborted) return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');
    if (await this.cancelled(checkpoint, 'opening_prs', 'Opening pull requests')) {
      return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');
    }
    const blockedBy: string[] = [];
    for (const repositoryId of Object.keys(worktrees)) {
      const problem = await this.publishRepository(
        checkpoint,
        repositoryId,
        worktrees,
        verification[repositoryId] ?? []
      );
      if (problem) blockedBy.push(problem);
    }

    // Feature1 moves the artifact to Testing only when every repository has
    // a verified result, and refuses the call otherwise — so the worker
    // decides here rather than being told.
    const unfinished = execution.repositories.filter(
      (r) => !this.deps.store.repository(checkpoint, r.id).reported
    );
    if (unfinished.length > 0) {
      return this.finish(
        checkpoint,
        'failed',
        `${unfinished.length} of ${execution.repositories.length} repositories did not finish. ` +
          blockedBy.join(' ')
      );
    }
    return this.finish(checkpoint, 'ready_for_testing', this.summaryFor(checkpoint));
  }

  /** Set a stage, and notice if somebody cancelled while we were working. */
  private async cancelled(
    checkpoint: ExecutionCheckpoint,
    state: ExecutionState,
    message: string
  ): Promise<boolean> {
    this.log(`${checkpoint.execution.id} → ${state}: ${message}`);
    checkpoint.lastMessage = message;
    const { cancelRequested } = await this.say(checkpoint, {
      state,
      message: this.deps.redactor.line(message, 2000),
    });
    return cancelRequested;
  }

  /** Commit whatever the agent changed, per repository. */
  private async commitUnit(
    checkpoint: ExecutionCheckpoint,
    worktrees: Record<string, string>,
    unit: Snapshot
  ): Promise<void> {
    this.assertLive('committing');
    for (const [repositoryId, tree] of Object.entries(worktrees)) {
      const row = this.deps.store.repository(checkpoint, repositoryId);
      try {
        const paths = await this.deps.git.changedPaths(tree);
        if (paths.length === 0) continue;
        const sha = await this.deps.git.commit(
          tree,
          commitMessageFor(checkpoint.execution, unit),
          paths
        );
        if (sha) {
          row.changed = true;
          row.headCommit = sha;
        }
      } catch (error) {
        this.log(
          `${repositoryId}: could not commit — ${this.deps.redactor.line((error as Error).message)}`
        );
      }
    }
    this.deps.store.save(checkpoint, this.now());
  }

  /**
   * Push, open the pull request, and report the repository.
   *
   * Returns a sentence when the repository cannot be handed over, which is
   * not the same as an error: a repository whose checks failed is a
   * perfectly ordinary outcome that Feature1 simply will not accept as a
   * result. The reason travels into the execution's failure message.
   */
  private async publishRepository(
    checkpoint: ExecutionCheckpoint,
    repositoryId: string,
    worktrees: Record<string, string>,
    verification: VerificationResult[]
  ): Promise<string | null> {
    const { execution } = checkpoint;
    const row = this.deps.store.repository(checkpoint, repositoryId);
    if (row.reported) return null;
    const repo = authorisedRepository(execution, repositoryId);
    const tree = worktrees[repositoryId];
    const branch = executionBranch(execution.id);

    // Feature1 takes only green results. Found out here rather than by
    // spending a lease on a 400.
    const verdict = canReport(verification, []);
    if (!verdict.ok) {
      row.error = verdict.reason;
      this.deps.store.save(checkpoint, this.now());
      return `${repo.name}: ${verdict.reason}.`;
    }

    try {
      const baseCommit =
        row.baseCommit ?? (await this.deps.git.baseCommit(execution.tenant_id, repo));
      row.baseCommit = baseCommit;

      if (!row.changed) {
        // Nothing to do here, and that is an ordinary outcome. The server
        // insists base and head match, which they do by construction.
        row.headCommit = baseCommit;
        row.outcome = 'no_changes';
        return this.reportRepository(checkpoint, row, verification, []);
      }

      this.assertLive(`pushing ${repo.name}`);
      if (!row.pushed) {
        await this.deps.git.push(tree, branch, repo.base_branch);
        row.pushed = true;
        this.deps.store.save(checkpoint, this.now());
      }
      row.commits = await this.deps.git.commitsSince(tree, baseCommit);
      row.headCommit = await this.deps.git.headCommit(tree);

      this.assertLive(`opening the pull request for ${repo.name}`);
      const origin = await this.deps.git.originUrl(tree);
      const github = PullRequests.repoFrom(origin);
      if (!github) throw new Error(`Could not tell which GitHub repository ${origin} is`);
      const pr = await this.deps.pullRequests.ensure({
        worktree: tree,
        owner: github.owner,
        name: github.name,
        headBranch: branch,
        baseBranch: repo.base_branch,
        title:
          `${execution.snapshot.code ?? ''} ${execution.snapshot.title ?? 'Implementation'}`.trim(),
        body: pullRequestBody({
          ...(execution.snapshot.code ? { artifactCode: execution.snapshot.code } : {}),
          artifactTitle: execution.snapshot.title ?? 'Implementation',
          executionId: execution.id,
          requirementsRevision: execution.snapshot.digest,
          acceptanceCriteria: (execution.snapshot.acceptanceCriteria ?? [])
            .map((ac, i) => ({ id: String(ac.id ?? i), text: criterionText(ac) }))
            .filter((ac) => ac.text),
          verification: verification.map((r) => ({
            name: r.name,
            outcome: r.outcome,
            ...(r.reason ? { reason: r.reason } : {}),
          })),
        }),
      });
      // Written down the moment it exists. A crash between opening and
      // recording is how a second pull request gets opened on the retry.
      row.pullRequestUrl = pr.url;
      row.outcome = 'pr_created';
      this.deps.store.save(checkpoint, this.now());
      return this.reportRepository(checkpoint, row, verification, [pr.url]);
    } catch (error) {
      if (error instanceof StaleAttemptError) throw error;
      row.error = this.deps.redactor.line(
        error instanceof GitError ? error.failure.message : (error as Error).message
      );
      this.deps.store.save(checkpoint, this.now());
      return `${repo.name}: ${row.error}.`;
    }
  }

  /**
   * Hand one repository to Feature1, which attaches its pull requests.
   *
   * The attach is the server's, not the worker's — it re-resolves ownership
   * at that moment and refuses a pull request that belongs to a different
   * repository. That refusal is a 409 and is not retried: a pull request
   * attached to the wrong artifact is the kind of mistake nobody finds for
   * weeks, and the server catching it is the point.
   */
  private async reportRepository(
    checkpoint: ExecutionCheckpoint,
    row: RepositoryCheckpoint,
    verification: VerificationResult[],
    prUrls: string[]
  ): Promise<string | null> {
    const result: RepositoryResult = {
      repository_id: row.repositoryId,
      outcome: row.outcome ?? 'no_changes',
      base_commit: row.baseCommit ?? '',
      head_commit: row.headCommit ?? row.baseCommit ?? '',
      tests: passingTests(verification.map((r) => ({ command: r.command, exitCode: r.exitCode }))),
      pr_urls: prUrls,
    };
    // Checked against the server's own rules first: a malformed result is
    // a 400 that costs an attempt, and the mistake would be ours.
    const problem = repositoryResultProblem(result);
    if (problem) {
      row.error = `Could not report this repository: ${problem}`;
      this.deps.store.save(checkpoint, this.now());
      return `${row.repositoryId}: ${problem}.`;
    }
    this.assertLive(`reporting ${row.repositoryId}`);
    await this.say(checkpoint, { repository_result: result });
    row.reported = true;
    this.deps.store.save(checkpoint, this.now());
    return null;
  }

  private summaryFor(checkpoint: ExecutionCheckpoint): string {
    const rows = checkpoint.repositories;
    const opened = rows.filter((r) => r.pullRequestUrl).length;
    const untouched = rows.filter((r) => r.outcome === 'no_changes').length;
    return [
      `${opened} pull request${opened === 1 ? '' : 's'} opened`,
      ...(untouched ? [`${untouched} repository needed no change`] : []),
      'all checks passed',
    ].join('; ');
  }

  private async blocked(checkpoint: ExecutionCheckpoint, question: string): Promise<Ending> {
    return this.finish(checkpoint, 'blocked', question);
  }

  /**
   * The last word, sent once.
   *
   * Recorded as reported only after Feature1 accepts it, so a worker that
   * dies between sending and recording sends it again on restart — which is
   * safe because the server treats a terminal state re-sent with the same
   * lease as a no-op.
   */
  private async finish(
    checkpoint: ExecutionCheckpoint,
    state: Ending,
    message: string
  ): Promise<Ending> {
    checkpoint.state = state;
    checkpoint.lastMessage = message;
    this.deps.store.save(checkpoint, this.now());
    await this.say(checkpoint, { state, message: this.deps.redactor.line(message, 2000) });
    checkpoint.reported = true;
    this.deps.store.save(checkpoint, this.now());
    this.log(`${checkpoint.execution.id} → ${state}: ${message}`);
    return state;
  }
}

export { STAGES };
export type { Execution };
