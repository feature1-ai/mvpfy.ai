import * as path from 'node:path';
import {
  Assignment,
  BlockedQuestion,
  ExecutionOutcome,
  ExecutionState,
  RepositoryResult,
  StaleAttemptError,
  VerificationResult,
} from '../shared/runner/contract';
import { authorisedRepository, idempotencyKey, orderedItems } from '../shared/runner/validate';
import { Feature1Transport, withRetry } from './transport';
import { ExecutionCheckpoint, ExecutionStore } from './store';
import { Layout, executionBranch } from './layout';
import { Git, GitError } from './git';
import { Verifier, verificationFailed, verificationHeld } from './verify';
import { PullRequests, pullRequestBody } from './prs';
import { AgentKind, AgentRunner } from './agentRun';
import { Redactor } from './redact';
import { buildPrompt, commitMessageFor } from './prompt';

/**
 * One execution, from a claimed assignment to a reported result.
 *
 * Three ideas hold this together, and everything else is detail.
 *
 * **Nothing is believed because an agent said so.** An agent that writes no
 * code exits zero. So after it finishes the worker goes and looks: what
 * changed, what was committed, what the checks returned, whether a pull
 * request exists. Every one of those is read from git or GitHub.
 *
 * **Every step is a checkpoint.** The worker is killed mid-execution as a
 * matter of routine — a container restart, a deploy, a laptop lid. Resuming
 * has to be cheaper and safer than starting again, and "safer" is the real
 * reason: an execution that starts again opens a second pull request.
 *
 * **Partial is reported as partial.** Two repositories succeeding and a
 * third failing is exactly that. Rolling it up as failure throws away work
 * that exists; rolling it up as success claims work that does not.
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
  runnerId: string;
  log?: (message: string) => void;
  /** Injected so tests need no clock. */
  now?: () => Date;
  /** Injected so a retrying test does not wait out real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LeaseLike {
  readonly attemptToken: string;
  assertLive(step: string): void;
  readonly live: boolean;
}

export class ExecutionEngine {
  private readonly now: () => Date;
  private readonly retry: <T>(operation: () => Promise<T>) => Promise<T>;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.retry = (operation) => withRetry(operation, deps.sleep ? { sleep: deps.sleep } : {});
  }

  private log(message: string): void {
    this.deps.log?.(this.deps.redactor.line(message, 500));
  }

  /** Say where we are, and write it down before saying it. */
  private async setState(
    checkpoint: ExecutionCheckpoint,
    state: ExecutionState,
    detail: string,
    lease: LeaseLike
  ): Promise<void> {
    checkpoint.state = state;
    checkpoint.lastDetail = detail;
    this.deps.store.save(checkpoint, this.now());
    this.log(`${checkpoint.assignment.executionId} → ${state}: ${detail}`);
    const { assignment } = checkpoint;
    await this.retry(() =>
      this.deps.transport.progress({
        contractVersion: assignment.contractVersion,
        runnerId: this.deps.runnerId,
        assignmentId: assignment.assignmentId,
        attemptToken: lease.attemptToken,
        state,
        detail: this.deps.redactor.line(detail),
        idempotencyKey: idempotencyKey({
          executionId: assignment.executionId,
          attemptId: assignment.attemptId,
          kind: 'progress',
          discriminator: state,
        }),
      })
    );
  }

  /**
   * Run it.
   *
   * Returns the outcome it reported. A `StaleAttemptError` escaping is the
   * one case where nothing is reported at all — by then this worker has no
   * standing to say anything about the execution.
   */
  async run(
    checkpoint: ExecutionCheckpoint,
    lease: LeaseLike,
    signal: AbortSignal
  ): Promise<ExecutionOutcome> {
    const { assignment } = checkpoint;
    try {
      return await this.execute(checkpoint, lease, signal);
    } catch (error) {
      if (error instanceof StaleAttemptError) {
        // Somebody else owns this now. The local work stays on disk; saying
        // anything authoritative about it would be a lie.
        this.log(`${assignment.executionId}: lease lost, stopping without reporting`);
        checkpoint.state = 'failed';
        this.deps.store.save(checkpoint, this.now());
        throw error;
      }
      const message = this.deps.redactor.line((error as Error).message ?? String(error));
      this.log(`${assignment.executionId} failed: ${message}`);
      return this.report(checkpoint, lease, 'failed', `The execution stopped: ${message}`);
    }
  }

  private async execute(
    checkpoint: ExecutionCheckpoint,
    lease: LeaseLike,
    signal: AbortSignal
  ): Promise<ExecutionOutcome> {
    const { assignment } = checkpoint;

    // -- prepare ------------------------------------------------------------
    await this.setState(checkpoint, 'preparing', 'Setting up the checkouts', lease);
    const worktrees: Record<string, string> = {};
    for (const repo of assignment.repositories) {
      const row = this.deps.store.repository(checkpoint, repo.repositoryId);
      try {
        worktrees[repo.repositoryId] = await this.deps.git.prepareWorktree(
          assignment.tenantId,
          assignment.executionId,
          authorisedRepository(assignment, repo.repositoryId)
        );
        row.prepared = true;
      } catch (error) {
        // A repository that cannot be cloned is a question, not a crash: the
        // other repositories may still be buildable, and somebody has to be
        // told which one is unreachable.
        row.prepared = false;
        row.result = {
          repositoryId: repo.repositoryId,
          changed: false,
          headBranch: null,
          headCommit: null,
          commits: [],
          verification: [],
          pullRequest: null,
          error: this.deps.redactor.line(
            error instanceof GitError ? error.failure.message : (error as Error).message
          ),
        };
      }
      this.deps.store.save(checkpoint, this.now());
    }
    if (Object.keys(worktrees).length === 0) {
      return this.blocked(checkpoint, lease, [
        {
          id: 'repos-unavailable',
          kind: 'repository_unavailable',
          text:
            'None of this assignment’s repositories could be cloned. Check the clone URLs ' +
            'and that the worker’s credentials can read them.',
        },
      ]);
    }

    // -- implement ----------------------------------------------------------
    const items = orderedItems(assignment);
    if (items === null) {
      return this.blocked(checkpoint, lease, [
        {
          id: 'dependency-graph',
          kind: 'requirements_unclear',
          text:
            'The selected stories depend on each other in a way that has no order — a ' +
            'cycle, or a dependency on something that was not sent. Which should be built first?',
        },
      ]);
    }
    // A standalone story has no items: the artifact itself is the work.
    const units = items.length > 0 ? items : [null];
    const questionsFile = path.join(
      this.deps.layout.agentDir(assignment.tenantId, assignment.executionId),
      'mvpfy-questions.md'
    );

    for (const [index, item] of units.entries()) {
      if (signal.aborted) return this.cancelled(checkpoint, lease);
      const id = item?.id ?? assignment.artifact.id;
      if (checkpoint.completedItems.includes(id)) continue;
      const label = item
        ? `${item.code ?? item.id} — ${item.title}`
        : assignment.requirements.title;
      await this.setState(
        checkpoint,
        'implementing',
        `Building ${label} (${index + 1} of ${units.length})`,
        lease
      );
      const outcome = await this.deps.agent.run({
        kind: this.deps.agentKind,
        ...(this.deps.agentModel ? { model: this.deps.agentModel } : {}),
        prompt: buildPrompt({ assignment, worktrees, questionsFile, item }),
        cwd: this.deps.layout.executionDir(assignment.tenantId, assignment.executionId),
        agentDir: this.deps.layout.agentDir(assignment.tenantId, assignment.executionId),
        questionsFile,
        signal,
      });
      if (outcome.cancelled || signal.aborted) return this.cancelled(checkpoint, lease);
      if (outcome.questions.length > 0) {
        return this.blocked(
          checkpoint,
          lease,
          outcome.questions.map((text, i) => ({
            id: `q-${index}-${i}`,
            kind: 'setup_question' as const,
            text: this.deps.redactor.line(text, 500),
          }))
        );
      }
      if (outcome.code !== 0) {
        // An agent that exited non-zero has not necessarily done nothing, so
        // the work is still collected and reported below — but the execution
        // is not going to be called ready.
        this.log(`${assignment.executionId}: agent exited ${outcome.code} on ${label}`);
      }
      // Committed per unit, so a crash later does not lose it and a reviewer
      // can tell one story's work from another's.
      await this.commitUnit(checkpoint, worktrees, item, lease);
      checkpoint.completedItems.push(id);
      this.deps.store.save(checkpoint, this.now());
    }

    // -- verify -------------------------------------------------------------
    if (signal.aborted) return this.cancelled(checkpoint, lease);
    await this.setState(checkpoint, 'verifying', 'Running the checks', lease);
    const verification: Record<string, VerificationResult[]> = {};
    for (const repositoryId of Object.keys(worktrees)) {
      verification[repositoryId] = await this.deps.verifier.verifyRepository(
        assignment,
        repositoryId,
        { worktrees, signal }
      );
    }

    // -- publish ------------------------------------------------------------
    if (signal.aborted) return this.cancelled(checkpoint, lease);
    await this.setState(checkpoint, 'opening_prs', 'Opening pull requests', lease);
    for (const repositoryId of Object.keys(worktrees)) {
      await this.publishRepository(checkpoint, repositoryId, worktrees, verification, lease);
    }

    const results = this.resultsOf(checkpoint);
    const anyError = results.some((r) => r.error);
    const stepsFor = (repositoryId: string) =>
      assignment.verification.steps.filter((s) => s.repositoryId === repositoryId);
    // Only a check that ran and said no fails the execution. One that could
    // not run is reported, loudly, but does not turn work that may be fine
    // into a failure — see verificationHeld for why those are two questions.
    const anyFailed = Object.entries(verification).some(([repositoryId, rows]) =>
      verificationFailed(rows, stepsFor(repositoryId))
    );
    const held = Object.entries(verification).every(([repositoryId, rows]) =>
      verificationHeld(rows, stepsFor(repositoryId))
    );
    const outcome: ExecutionOutcome = anyError || anyFailed ? 'failed' : 'ready_for_testing';
    return this.report(checkpoint, lease, outcome, this.summaryFor(results, held, anyFailed));
  }

  /** Commit whatever the agent changed, per repository. */
  private async commitUnit(
    checkpoint: ExecutionCheckpoint,
    worktrees: Record<string, string>,
    item: Parameters<typeof commitMessageFor>[1],
    lease: LeaseLike
  ): Promise<void> {
    lease.assertLive('committing');
    for (const [repositoryId, tree] of Object.entries(worktrees)) {
      const row = this.deps.store.repository(checkpoint, repositoryId);
      try {
        const paths = await this.deps.git.changedPaths(tree);
        if (paths.length === 0) continue;
        const sha = await this.deps.git.commit(
          tree,
          commitMessageFor(checkpoint.assignment, item),
          paths
        );
        if (sha) {
          row.changed = true;
          row.headCommit = sha;
          row.implemented = true;
        }
      } catch (error) {
        // A commit that will not happen is recorded against the repository
        // when it publishes; here it only means this unit added nothing.
        this.log(
          `${repositoryId}: could not commit — ${this.deps.redactor.line((error as Error).message)}`
        );
      }
    }
    this.deps.store.save(checkpoint, this.now());
  }

  /**
   * Push, open the pull request, and attach it — each one guarded.
   *
   * The lease is checked immediately before each of the three, not once at
   * the top: this is the stretch where a reassignment does real damage, and
   * the gap between checking and acting is where it lands.
   */
  private async publishRepository(
    checkpoint: ExecutionCheckpoint,
    repositoryId: string,
    worktrees: Record<string, string>,
    verification: Record<string, VerificationResult[]>,
    lease: LeaseLike
  ): Promise<void> {
    const { assignment } = checkpoint;
    const row = this.deps.store.repository(checkpoint, repositoryId);
    const repo = authorisedRepository(assignment, repositoryId);
    const tree = worktrees[repositoryId];
    const branch = executionBranch(assignment.executionId);
    const rows = verification[repositoryId] ?? [];

    const base: RepositoryResult = {
      repositoryId,
      changed: row.changed,
      headBranch: row.changed ? branch : null,
      headCommit: row.headCommit,
      commits: [],
      verification: rows,
      pullRequest: row.pullRequest,
    };

    // Nothing changed here. An ordinary outcome, not a failure: the agent
    // decided this repository needed nothing.
    if (!row.changed) {
      row.result = { ...base, changed: false };
      this.deps.store.save(checkpoint, this.now());
      return;
    }

    try {
      base.commits = await this.deps.git.commitsSince(tree, repo.baseCommit);

      lease.assertLive(`pushing ${repositoryId}`);
      if (!row.pushed) {
        await this.deps.git.push(tree, branch, repo.baseBranch);
        row.pushed = true;
        this.deps.store.save(checkpoint, this.now());
      }

      lease.assertLive(`opening the pull request for ${repositoryId}`);
      const origin = await this.deps.git.originUrl(tree);
      const github = PullRequests.repoFrom(origin);
      if (!github) throw new Error(`Could not tell which GitHub repository ${origin} is`);
      const pr = await this.deps.pullRequests.ensure({
        worktree: tree,
        owner: github.owner,
        name: github.name,
        headBranch: branch,
        baseBranch: repo.baseBranch,
        title: `${assignment.artifact.code ?? assignment.artifact.id}: ${
          assignment.artifact.title ?? assignment.requirements.title
        }`,
        body: pullRequestBody({
          ...(assignment.artifact.code ? { artifactCode: assignment.artifact.code } : {}),
          artifactTitle: assignment.artifact.title ?? assignment.requirements.title,
          executionId: assignment.executionId,
          requirementsRevision: assignment.requirements.revision,
          acceptanceCriteria: assignment.requirements.acceptanceCriteria,
          verification: rows.map((r) => ({
            name: r.name,
            outcome: r.outcome,
            ...(r.reason ? { reason: r.reason } : {}),
          })),
        }),
      });
      // Written down the moment it exists. A crash between opening and
      // recording is how a second pull request gets opened on the retry.
      row.pullRequest = pr;
      this.deps.store.save(checkpoint, this.now());

      lease.assertLive(`attaching the pull request for ${repositoryId}`);
      await this.attach(checkpoint, repositoryId, pr, lease);
      row.result = { ...base, pullRequest: pr };
    } catch (error) {
      if (error instanceof StaleAttemptError) throw error;
      // This repository did not finish. The others still report, and the
      // pull request already opened is kept rather than forgotten.
      row.result = {
        ...base,
        error: this.deps.redactor.line(
          error instanceof GitError ? error.failure.message : (error as Error).message
        ),
      };
    }
    this.deps.store.save(checkpoint, this.now());
  }

  /**
   * Attach the pull request to the artifact Feature1 says owns it.
   *
   * Feature1 resolves ownership and returns where it actually attached. A
   * disagreement is reported rather than accepted: silently hanging a pull
   * request off the wrong artifact is the kind of error nobody finds for
   * weeks.
   */
  private async attach(
    checkpoint: ExecutionCheckpoint,
    repositoryId: string,
    pullRequest: NonNullable<ExecutionCheckpoint['repositories'][number]['pullRequest']>,
    lease: LeaseLike
  ): Promise<void> {
    const { assignment } = checkpoint;
    const response = await this.retry(() =>
      this.deps.transport.attachPr({
        contractVersion: assignment.contractVersion,
        runnerId: this.deps.runnerId,
        executionId: assignment.executionId,
        attemptToken: lease.attemptToken,
        expectedOwner: assignment.prOwner,
        originArtifact: assignment.artifact,
        pullRequest,
        idempotencyKey: idempotencyKey({
          executionId: assignment.executionId,
          attemptId: assignment.attemptId,
          kind: 'attach_pr',
          discriminator: repositoryId,
        }),
      })
    );
    const expected = assignment.prOwner;
    if (
      response?.attachedTo &&
      (response.attachedTo.type !== expected.type || response.attachedTo.id !== expected.id)
    ) {
      throw new Error(
        `Feature1 attached ${pullRequest.url} to ${response.attachedTo.type} ` +
          `${response.attachedTo.id}, not the ${expected.type} ${expected.id} this assignment named`
      );
    }
  }

  private resultsOf(checkpoint: ExecutionCheckpoint): RepositoryResult[] {
    return checkpoint.repositories
      .map((row) => row.result)
      .filter((r): r is RepositoryResult => r !== null);
  }

  private summaryFor(results: RepositoryResult[], held: boolean, anyFailed: boolean): string {
    const opened = results.filter((r) => r.pullRequest).length;
    const failed = results.filter((r) => r.error).length;
    const untouched = results.filter((r) => !r.changed && !r.error).length;
    const parts = [
      `${opened} pull request${opened === 1 ? '' : 's'} opened`,
      ...(untouched ? [`${untouched} repository needed no change`] : []),
      ...(failed ? [`${failed} did not finish`] : []),
      // Said plainly, because "ready for testing" must never be read as
      // "checked" when nothing could be checked.
      ...(anyFailed ? ['checks failed'] : held ? [] : ['not everything could be checked']),
    ];
    return parts.join('; ');
  }

  private async blocked(
    checkpoint: ExecutionCheckpoint,
    lease: LeaseLike,
    questions: BlockedQuestion[]
  ): Promise<ExecutionOutcome> {
    const { assignment } = checkpoint;
    checkpoint.state = 'blocked';
    this.deps.store.save(checkpoint, this.now());
    await this.retry(() =>
      this.deps.transport.blocked({
        contractVersion: assignment.contractVersion,
        runnerId: this.deps.runnerId,
        assignmentId: assignment.assignmentId,
        attemptToken: lease.attemptToken,
        questions,
        idempotencyKey: idempotencyKey({
          executionId: assignment.executionId,
          attemptId: assignment.attemptId,
          kind: 'blocked',
        }),
      })
    );
    return this.report(
      checkpoint,
      lease,
      'blocked',
      `Stopped to ask ${questions.length} question${questions.length === 1 ? '' : 's'}`
    );
  }

  private async cancelled(
    checkpoint: ExecutionCheckpoint,
    lease: LeaseLike
  ): Promise<ExecutionOutcome> {
    checkpoint.state = 'cancelling';
    this.deps.store.save(checkpoint, this.now());
    return this.report(checkpoint, lease, 'cancelled', 'Cancelled before it finished');
  }

  /**
   * The final word, sent once.
   *
   * Recorded as reported only after Feature1 accepts it, so a worker that
   * dies between sending and recording resends on restart — and the
   * idempotency key is what makes that safe rather than a second result.
   */
  private async report(
    checkpoint: ExecutionCheckpoint,
    lease: LeaseLike,
    outcome: ExecutionOutcome,
    summary: string
  ): Promise<ExecutionOutcome> {
    const { assignment } = checkpoint;
    const state: ExecutionState =
      outcome === 'ready_for_testing'
        ? 'ready_for_testing'
        : outcome === 'cancelled'
          ? 'cancelled'
          : outcome === 'blocked'
            ? 'blocked'
            : 'failed';
    checkpoint.state = state;
    this.deps.store.save(checkpoint, this.now());
    await this.retry(() =>
      this.deps.transport.result({
        contractVersion: assignment.contractVersion,
        runnerId: this.deps.runnerId,
        assignmentId: assignment.assignmentId,
        attemptToken: lease.attemptToken,
        outcome,
        summary: this.deps.redactor.line(summary),
        repositories: this.resultsOf(checkpoint),
        requirementsRevision: assignment.requirements.revision,
        idempotencyKey: idempotencyKey({
          executionId: assignment.executionId,
          attemptId: assignment.attemptId,
          kind: 'result',
        }),
      })
    );
    checkpoint.reported = true;
    this.deps.store.save(checkpoint, this.now());
    return outcome;
  }
}

/** Re-exported so callers need not reach into the contract for the type. */
export type { Assignment };
