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
  parseCredentials,
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
import { CredentialSession } from './credentials';
import { buildPrompt, buildRepairPrompt, commitMessageFor, criterionText } from './prompt';
import { readGuidance } from './guidance';
import { RepositoryChecks, failureBrief, failureSummary } from './checks';
import { UnitDriver, runUnits } from '../shared/unitRunner';

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
  /**
   * Tries each story gets, the first included, before the execution fails.
   * 1 turns repair off: a failing check then fails the execution at once.
   */
  unitAttempts?: number;
  /**
   * The credentials a claim carries, when Feature1 issues them. Without it
   * the worker runs on whatever its operator configured, as it always has.
   */
  credentials?: CredentialSession;
  log?: (message: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A first try and two repairs. Enough to fix a failure the agent can see,
 * and few enough that a story which cannot pass stops within the hour
 * instead of spending the day.
 */
export const DEFAULT_UNIT_ATTEMPTS = 3;

/** How a story is named to a person: its code and its title. */
function unitLabel(unit: Snapshot): string {
  return `${unit.code ?? unit.id} — ${unit.title ?? 'work'}`;
}

/** Why an execution stopped. What the worker tells Feature1 last. */
export type Ending = 'ready_for_testing' | 'blocked' | 'failed' | 'cancelled';

/**
 * Feature1 answered `cancel_requested` instead of doing what was asked.
 *
 * Thrown rather than returned, because it was returned once and the two
 * call sites that mattered — reporting a repository and reporting the final
 * state — both ignored it. The server had recorded nothing and the worker
 * marked itself finished, so an execution somebody cancelled sat in
 * Feature1 as `cancelling` forever while the worker believed it was done.
 *
 * As an exception there is no call site to forget: every call goes through
 * one place, and the only body exempt is the acknowledgement itself.
 */
export class CancellationRequested extends Error {
  constructor() {
    super('Feature1 asked for this execution to be cancelled');
    this.name = 'CancellationRequested';
  }
}

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
  ): Promise<void> {
    const { execution } = checkpoint;
    const response = await this.retry(() =>
      this.deps.transport.progress(execution.id, execution.lease_token, body)
    );
    const until = Date.parse(response?.lease_until ?? '');
    if (!Number.isNaN(until)) this.leaseUntil = until;
    this.renewCredentials(response?.credentials);
    // A cancelling run accepts nothing but the acknowledgement: the server
    // discards whatever was sent and answers this flag. Believing the call
    // landed is how a repository gets marked reported that the server never
    // recorded.
    if (response?.cancel_requested && body.state !== 'cancelled') {
      throw new CancellationRequested();
    }
    if (body.state) {
      checkpoint.state = body.state;
      this.deps.store.save(checkpoint, this.now());
    }
  }

  /**
   * Take newer credentials from a progress response.
   *
   * A GitHub app token lasts an hour and a feature can take longer, so the
   * heartbeat is how a long execution keeps being able to push. A malformed
   * set is dropped rather than fatal: the ones already held still work, and
   * failing an execution over a refresh it may not need helps nobody.
   */
  private renewCredentials(raw: unknown): void {
    if (!this.deps.credentials || raw === undefined || raw === null) return;
    try {
      this.deps.redactor.remember(...this.deps.credentials.refresh(parseCredentials(raw)));
    } catch (error) {
      this.log(
        `ignoring credentials Feature1 sent with a progress response: ${(error as Error).message}`
      );
    }
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
    try {
      await this.say(checkpoint, {});
      return { cancelRequested: false };
    } catch (error) {
      if (error instanceof CancellationRequested) return { cancelRequested: true };
      throw error;
    }
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
    // The lease token is this attempt's credential: kept out of every log and
    // report from here on, as config.ts always said it was. Nothing did it.
    this.deps.redactor.remember(execution.lease_token);
    // Same for whatever the claim issued — remembered before anything can
    // print it, and forgotten by the session when this attempt ends.
    this.deps.redactor.remember(...(this.deps.credentials?.begin(execution) ?? []));
    try {
      return await this.attempt(checkpoint, signal);
    } finally {
      this.deps.credentials?.end();
    }
  }

  private async attempt(checkpoint: ExecutionCheckpoint, signal: AbortSignal): Promise<Ending> {
    const { execution } = checkpoint;
    try {
      return await this.execute(checkpoint, signal);
    } catch (error) {
      if (error instanceof StaleAttemptError) {
        this.superseded = true;
        this.log(`${execution.id}: ${error.message} — stopping without reporting`);
        this.deps.store.save(checkpoint, this.now());
        throw error;
      }
      if (error instanceof CancellationRequested) {
        // Wherever it was noticed, the answer is the same: stop, and say so
        // in the one way the server will accept.
        this.log(`${execution.id}: cancelled`);
        return this.finish(checkpoint, 'cancelled', 'Cancelled before it finished');
      }
      const message = this.deps.redactor.line((error as Error).message ?? String(error));
      this.log(`${execution.id} failed: ${message}`);
      return this.finish(checkpoint, 'failed', `The execution stopped: ${message}`);
    }
  }

  private async execute(checkpoint: ExecutionCheckpoint, signal: AbortSignal): Promise<Ending> {
    const { execution } = checkpoint;

    // -- prepare ------------------------------------------------------------
    await this.stage(checkpoint, 'preparing', 'Setting up the checkouts');
    const worktrees: Record<string, string> = {};
    for (const repo of execution.repositories) {
      const row = this.deps.store.repository(checkpoint, repo.id);
      if (row.reported) continue; // A previous attempt already finished it.
      // What went wrong last attempt is not this attempt's problem. Left in
      // the checkpoint, one GitHub 502 failed every reclaim after it, at the
      // `if (row.error)` in publishRepository, however healthy things became.
      delete row.error;
      try {
        const authorised = authorisedRepository(execution, repo.id);
        // Resolved once per execution, then kept. The branch is cut from this
        // commit, so re-resolving on a reclaim — after the base had moved —
        // made an untouched branch look changed and sent Feature1 a base the
        // work was never built on.
        row.baseCommit ??= await this.deps.git.baseCommit(execution.tenant_id, authorised);
        worktrees[repo.id] = await this.deps.git.prepareWorktree(
          execution.tenant_id,
          execution.id,
          authorised,
          row.baseCommit
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
    // One story at a time, each checked before the next is started. See
    // shared/unitRunner.ts for why: a failure found now is about one story,
    // and a failure found after the fifth is about all of them.
    const checks = new RepositoryChecks(this.deps.verifier, this.deps.git);
    const built = await runUnits<Snapshot, Ending>(
      units,
      this.unitDriver({ checkpoint, worktrees, units, questionsFile, checks, signal }),
      {
        isDone: (unit) => checkpoint.completedUnits.includes(unit.id),
        markDone: (unit) => {
          checkpoint.completedUnits.push(unit.id);
          this.deps.store.save(checkpoint, this.now());
        },
      },
      { maxAttempts: this.deps.unitAttempts ?? DEFAULT_UNIT_ATTEMPTS }
    );
    if (built.kind === 'stopped') return built.stop;
    if (built.kind === 'exhausted') {
      // Nothing is published. The stories after this one were never built,
      // and a pull request holding part of a feature whose checks fail is
      // not something to hand a reviewer. The commits stay in the checkout
      // for the attempt that comes next.
      const tries = `${built.attempts} attempt${built.attempts === 1 ? '' : 's'}`;
      // `reportable`, never `failure`: the brief the agent was given quotes the
      // end of what the failing command printed, and verify.ts says in as many
      // words that output is kept on the worker. Redacting a 600-character
      // slice of it is not the same promise — the redactor removes values it
      // was told about, and a test prints whatever its product prints.
      const why = built.reportable ? `${this.deps.redactor.line(built.reportable, 600)} ` : '';
      return this.finish(
        checkpoint,
        'failed',
        `${unitLabel(built.unit)}: its checks were still failing after ${tries}. ${why}` +
          'The work so far is kept for a retry; no pull request was opened.'
      );
    }

    // -- verify -------------------------------------------------------------
    if (signal.aborted) return this.finish(checkpoint, 'cancelled', 'Cancelled part-way');
    await this.stage(checkpoint, 'verifying', 'Running the checks');
    const verification: Record<string, VerificationResult[]> = {};
    for (const repositoryId of Object.keys(worktrees)) {
      // Through the same cache the stories used, so a repository already
      // checked at this commit is not run a second time just to be sure.
      const rows = await checks.verify(repositoryId, worktrees, signal);
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
    await this.stage(checkpoint, 'opening_prs', 'Opening pull requests');
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

  /**
   * How one story is built and judged.
   *
   * `work` is the agent; `check` is the repositories' own suites, run by the
   * worker. They are separate so that the agent finishing is never what
   * makes a story done.
   */
  private unitDriver(run: {
    checkpoint: ExecutionCheckpoint;
    worktrees: Record<string, string>;
    units: Snapshot[];
    questionsFile: string;
    checks: RepositoryChecks;
    signal: AbortSignal;
  }): UnitDriver<Snapshot, Ending> {
    const { checkpoint, worktrees, units, questionsFile, checks, signal } = run;
    const { execution } = checkpoint;
    const stop = async (ending: Promise<Ending>) => ({ kind: 'stop' as const, stop: await ending });
    const cancelled = () => stop(this.finish(checkpoint, 'cancelled', 'Cancelled part-way'));
    // Which repositories each unit has changed, accumulated across its
    // attempts: a repair may touch a repository the first attempt did not, and
    // the check has to cover everything this story has now altered.
    const touchedByUnit = new Map<string, Set<string>>();
    const noteTouched = (unit: Snapshot, repositoryIds: string[]) => {
      const seen = touchedByUnit.get(unit.id) ?? new Set<string>();
      for (const id of repositoryIds) seen.add(id);
      touchedByUnit.set(unit.id, seen);
    };

    return {
      work: async (unit, attempt) => {
        if (signal.aborted) return cancelled();
        const label = unitLabel(unit);
        const position = `${units.indexOf(unit) + 1} of ${units.length}`;
        // Both are the implementing stage as far as Feature1 is concerned: a
        // stage may not move backwards, and fixing a story is still building it.
        await this.stage(
          checkpoint,
          'implementing',
          attempt.number === 1
            ? `Building ${label} (${position})`
            : `Fixing ${label} after its checks failed (attempt ${attempt.number} of ${attempt.of})`
        );

        // Asked for each run, not once: a long feature outlives a token, and
        // the session holds whichever one the last heartbeat brought.
        const planningMcp = this.deps.credentials?.agentMcp() ?? null;
        const guidance = readGuidance(this.deps.layout.root);
        const brief = {
          execution,
          worktrees,
          questionsFile,
          unit,
          planningContext: Boolean(planningMcp),
          ...(guidance ? { guidance } : {}),
        };
        const outcome = await this.deps.agent.run({
          kind: this.deps.agentKind,
          ...(this.deps.agentModel ? { model: this.deps.agentModel } : {}),
          prompt:
            attempt.failure === undefined
              ? buildPrompt(brief)
              : buildRepairPrompt(brief, {
                  failure: attempt.failure,
                  attempt: attempt.number,
                  of: attempt.of,
                }),
          cwd: this.deps.layout.executionDir(execution.tenant_id, execution.id),
          agentDir: this.deps.layout.agentDir(execution.tenant_id, execution.id),
          questionsFile,
          ...(planningMcp ? { mcp: { url: planningMcp.url, token: planningMcp.token } } : {}),
          signal,
        });
        if (outcome.cancelled || signal.aborted) return cancelled();
        if (outcome.questions.length > 0) {
          // Feature1 takes one message, and a person reads it. Numbered, so
          // the answer can address them one at a time.
          return stop(
            this.blocked(checkpoint, outcome.questions.map((q, i) => `${i + 1}. ${q}`).join(' '))
          );
        }
        if (outcome.code !== 0 || outcome.timedOut) {
          // An agent that crashed or ran out of time did not finish the unit.
          // It used to be logged and then counted as done anyway — verified,
          // handed over half-built, and never attempted again on a reclaim.
          // What it did write is committed, so the next attempt builds on it,
          // and the unit stays open for that attempt. The tail stays on the
          // worker for the operator; it is never reported.
          this.log(`${execution.id}: agent exited ${outcome.code} on ${label}: ${outcome.tail}`);
          noteTouched(unit, await this.commitUnit(checkpoint, worktrees, unit));
          this.deps.store.save(checkpoint, this.now());
          const why = outcome.timedOut
            ? 'ran out of time'
            : `stopped with exit code ${outcome.code ?? 'unknown'}`;
          return stop(
            this.finish(checkpoint, 'failed', `The coding agent ${why} while building ${label}.`)
          );
        }
        noteTouched(unit, await this.commitUnit(checkpoint, worktrees, unit));
        return { kind: 'done' };
      },

      check: async (unit) => {
        const failures: Array<{ repositoryName: string; result: VerificationResult }> = [];
        // Only the repositories this story changed. Checking all of them made
        // the first story answer for the state of the whole product: a
        // repository already red at its base commit — a flake, a missing
        // fixture, a suite that was broken before any of this started — failed
        // US-01, and every repair attempt was spent telling the agent to fix
        // something buildRepairPrompt also tells it is not its to fix. The
        // execution then ended naming the wrong cause, with the later stories
        // never built. A whole-repository failure is still caught, in the
        // verify stage, where it is reported against the repository.
        const touched = touchedByUnit.get(unit.id) ?? new Set<string>();
        for (const repositoryId of Object.keys(worktrees)) {
          if (!touched.has(repositoryId)) continue;
          if (signal.aborted) return cancelled();
          const results = await checks.verify(repositoryId, worktrees, signal);
          const repositoryName = authorisedRepository(execution, repositoryId).name;
          for (const result of results) {
            // Only what ran and said no. A repository with nothing to run is
            // not something another attempt can fix, and is dealt with where
            // it always was: it cannot be handed over.
            if (result.outcome === 'failed' && !result.optional) {
              failures.push({ repositoryName, result });
            }
          }
        }
        if (signal.aborted) return cancelled();
        if (failures.length === 0) return { kind: 'passed' };
        this.log(
          `${execution.id}: ${unitLabel(unit)} failed ${failures.length} check(s): ` +
            failures.map((f) => `${f.repositoryName} ${f.result.name}`).join(', ')
        );
        return {
          kind: 'failed',
          failure: failureBrief(failures),
          reportable: failureSummary(failures),
        };
      },
    };
  }

  /** Move to a stage. Throws CancellationRequested if somebody cancelled. */
  private async stage(
    checkpoint: ExecutionCheckpoint,
    state: ExecutionState,
    message: string
  ): Promise<void> {
    this.log(`${checkpoint.execution.id} → ${state}: ${message}`);
    checkpoint.lastMessage = message;
    await this.say(checkpoint, { state, message: this.deps.redactor.line(message, 2000) });
  }

  /**
   * Commit whatever the agent left uncommitted, per repository.
   *
   * Note what this does NOT decide: whether the repository changed. The
   * agent is told not to commit, and mostly does not, but an agent that
   * commits anyway leaves a clean working tree — and reading "clean" as
   * "nothing happened" reported `no_changes` for a repository with real
   * work in it, skipped its pull request, and claimed base and head were
   * the same commit when they were not. That question is answered from the
   * branch instead, in `changedSince`.
   *
   * A commit that fails is recorded against the repository rather than
   * logged and forgotten, for the same reason: work that is not committed
   * is not on the branch, and the honest outcome is a repository that did
   * not finish.
   */
  private async commitUnit(
    checkpoint: ExecutionCheckpoint,
    worktrees: Record<string, string>,
    unit: Snapshot
  ): Promise<string[]> {
    this.assertLive('committing');
    // Which repositories this unit actually changed. Returned because the
    // per-unit check uses it to decide what to run: a repository the story
    // never opened cannot have been broken by it.
    const touched: string[] = [];
    for (const [repositoryId, tree] of Object.entries(worktrees)) {
      const row = this.deps.store.repository(checkpoint, repositoryId);
      try {
        const { paths, withheld } = await this.deps.git.uncommitted(tree);
        // Said out loud. A file skipped for looking like a credential is a
        // decision somebody should know was made on their behalf — silently
        // leaving it out is how an agent's work appears to be missing.
        if (withheld.length > 0) {
          row.withheld = [...new Set([...(row.withheld ?? []), ...withheld])];
          this.log(
            `${repositoryId}: not committing ${withheld.length} file(s) that look like ` +
              `credentials — ${withheld.join(', ')}`
          );
        }
        if (paths.length === 0) continue;
        // Before the commit, not after: the files are in the worktree either
        // way, so the checks see this story's work whether committing it
        // succeeded or not, and a failed commit is exactly when the checks
        // should still run.
        touched.push(repositoryId);
        const sha = await this.deps.git.commit(
          tree,
          commitMessageFor(checkpoint.execution, unit),
          paths
        );
        if (sha) row.headCommit = sha;
      } catch (error) {
        row.error = `Could not commit the work in this repository: ${this.deps.redactor.line(
          (error as Error).message
        )}`;
        this.log(`${repositoryId}: ${row.error}`);
      }
    }
    this.deps.store.save(checkpoint, this.now());
    return touched;
  }

  /**
   * Does this branch hold anything the base does not?
   *
   * Asked of git rather than inferred from the working tree, so it is true
   * whoever made the commits — the worker, or an agent that ignored the
   * instruction not to.
   */
  private async changedSince(tree: string, baseCommit: string): Promise<boolean> {
    const head = await this.deps.git.headCommit(tree);
    return head !== baseCommit;
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

    // A commit that would not happen means the work is not on the branch.
    // Reporting the repository anyway would publish less than was built.
    if (row.error) return `${repo.name}: ${row.error}`;

    try {
      const baseCommit =
        row.baseCommit ?? (await this.deps.git.baseCommit(execution.tenant_id, repo));
      row.baseCommit = baseCommit;
      row.changed = await this.changedSince(tree, baseCommit);

      if (!row.changed) {
        // Nothing here, and that is an ordinary outcome. Feature1 insists
        // base and head match for it, which they do because the branch is
        // still sitting on the base commit.
        row.headCommit = baseCommit;
        row.outcome = 'no_changes';
        return this.reportRepository(checkpoint, row, verification, []);
      }

      // Anything left uncommitted at this point never reached the branch,
      // and pushing would open a pull request missing part of the work it
      // claims to be.
      if (await this.deps.git.hasUncommittedChanges(tree)) {
        row.error = 'Work was left uncommitted in this checkout and is not on the branch';
        this.deps.store.save(checkpoint, this.now());
        return `${repo.name}: ${row.error}.`;
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

  /**
   * The one sentence a product manager reads.
   *
   * It used to end "all checks passed" unconditionally, which was a lie in
   * the ordinary case: Feature1 needs only one passing command per
   * repository, so a repository can be handed over with its tests green and
   * its lint never run. "Ready for testing" is already easy to read as
   * "checked"; the summary must not help.
   */
  private summaryFor(checkpoint: ExecutionCheckpoint): string {
    const rows = checkpoint.repositories;
    const opened = rows.filter((r) => r.pullRequestUrl).length;
    const untouched = rows.filter((r) => r.outcome === 'no_changes').length;
    const withheld = [...new Set(rows.flatMap((r) => r.withheld ?? []))];
    const checks = rows.flatMap((r) => r.checks);
    const ran = checks.filter((c) => c.outcome === 'passed').length;
    const missed = checks.filter((c) => c.outcome !== 'passed');
    return [
      `${opened} pull request${opened === 1 ? '' : 's'} opened`,
      ...(untouched ? [`${untouched} repository needed no change`] : []),
      missed.length === 0
        ? `all ${ran} check${ran === 1 ? '' : 's'} passed`
        : `${ran} check${ran === 1 ? '' : 's'} passed, ${missed.length} could not run ` +
          `(${[...new Set(missed.map((c) => c.name))].join(', ')})`,
      ...(withheld.length > 0
        ? [
            `${withheld.length} file${withheld.length === 1 ? '' : 's'} left out for looking ` +
              `like credentials (${withheld.join(', ')})`,
          ]
        : []),
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
    try {
      await this.say(checkpoint, { state, message: this.deps.redactor.line(message, 2000) });
    } catch (error) {
      if (!(error instanceof CancellationRequested)) throw error;
      // Somebody cancelled while this was being written. The server took
      // none of it, so saying it was reported would be false — acknowledge
      // the cancellation instead, which is the only thing it will accept.
      this.log(`${checkpoint.execution.id}: cancelled while reporting ${state}`);
      return this.finish(checkpoint, 'cancelled', 'Cancelled before it finished');
    }
    checkpoint.reported = true;
    this.deps.store.save(checkpoint, this.now());
    this.log(`${checkpoint.execution.id} → ${state}: ${message}`);
    if (state === 'ready_for_testing') await this.removeWorktrees(checkpoint);
    return state;
  }

  /**
   * Handed over: everything is pushed, so the checkouts are only disk. A
   * failed or interrupted execution keeps its own, for the attempt after it.
   * Best effort — a checkout that will not go is a full disk later, not a
   * reason to call finished work anything else.
   */
  private async removeWorktrees(checkpoint: ExecutionCheckpoint): Promise<void> {
    const { execution } = checkpoint;
    for (const repo of execution.repositories) {
      try {
        await this.deps.git.removeWorktree(execution.tenant_id, execution.id, repo.id);
      } catch (error) {
        this.log(`${repo.id}: could not remove its checkout: ${(error as Error).message}`);
      }
    }
  }
}

export { STAGES };
export type { Execution };
