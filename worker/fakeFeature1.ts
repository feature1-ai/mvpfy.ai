import {
  Execution,
  ExecutionState,
  PROTOCOL_VERSION,
  ProgressBody,
  ProgressResponse,
  STAGES,
  StaleAttemptError,
  TransientTransportError,
} from '../shared/runner/contract';
import { repositoryResultProblem } from '../shared/runner/validate';
import { Feature1Transport } from './transport';

/**
 * Feature1, as far as the worker can tell.
 *
 * Not a mock with canned returns: it re-implements the rules
 * `ImplementationRuns.update` actually enforces, because the worker's
 * hardest behaviour is what it does when the server refuses it. A fake that
 * said yes to everything would pass every test and teach us nothing — and
 * the rules here are strict enough that several of them caught real bugs in
 * the worker the first time it ran against them.
 *
 * What it mirrors, in the server's own order:
 *   • the lease is a hash comparison and a clock, and either failing is 409;
 *   • a terminal state may be re-sent with the same lease and is a no-op;
 *   • a cancelling run answers `cancel_requested` to anything but `cancelled`;
 *   • a stage may not move backwards;
 *   • a repository result must carry passing checks and nothing else;
 *   • `ready_for_testing` needs a result for every selected repository.
 */
export class FakeFeature1 implements Feature1Transport {
  private queued: Execution[] = [];
  private runs = new Map<string, Execution>();
  private leases = new Map<string, string>();
  private cancelling = new Set<string>();
  private clock: () => number;

  /** Everything the worker sent, in order. Tests read these. */
  readonly progressCalls: Array<{ executionId: string; body: ProgressBody }> = [];
  readonly heartbeats: string[] = [];
  readonly attachedPrs: string[] = [];

  /** Make the next N calls of a kind fail as though the network dropped. */
  failNext: { claim?: number; progress?: number } = {};
  /** Reject the next attach as the server does when a PR is the wrong repo. */
  prBelongsElsewhere = new Set<string>();

  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? Date.now;
  }

  /** Queue work for a worker to claim. */
  offer(...executions: Execution[]): void {
    for (const execution of executions) {
      this.queued.push({ ...execution, state: 'queued' });
    }
  }

  /** Record a run without queueing it — the restart case. */
  known(...executions: Execution[]): void {
    for (const execution of executions) {
      this.runs.set(execution.id, { ...execution });
      this.leases.set(execution.id, execution.lease_token);
    }
  }

  /** Somebody pressed cancel. */
  cancel(executionId: string): void {
    this.cancelling.add(executionId);
    const run = this.runs.get(executionId);
    if (run) run.state = 'cancelling';
  }

  /** Hand the execution to a newer attempt, as an expired lease would. */
  supersede(executionId: string): string {
    const next = `${this.leases.get(executionId)?.slice(0, 60) ?? 'b'.repeat(60)}beef`;
    this.leases.set(executionId, next);
    const run = this.runs.get(executionId);
    if (run) run.attempt += 1;
    return next;
  }

  stateOf(executionId: string): ExecutionState | undefined {
    return this.runs.get(executionId)?.state;
  }

  resultsOf(executionId: string): Execution['results'] {
    return this.runs.get(executionId)?.results ?? {};
  }

  private maybeFail(kind: 'claim' | 'progress'): void {
    const left = this.failNext[kind] ?? 0;
    if (left > 0) {
      this.failNext[kind] = left - 1;
      throw new TransientTransportError(`fake: ${kind} is failing on purpose`);
    }
  }

  async claim(): Promise<Execution | null> {
    this.maybeFail('claim');
    // Expired cancellations are terminal and are not handed out again.
    for (const run of this.runs.values()) {
      if (run.state === 'cancelling' && this.expired(run.id)) run.state = 'cancelled';
    }
    const reclaimable = [...this.runs.values()].find(
      (r) => STAGES.includes(r.state) && this.expired(r.id)
    );
    const next = this.queued.shift() ?? reclaimable;
    if (!next) return null;
    const leaseToken = `${'c'.repeat(56)}${String(this.runs.size).padStart(8, '0')}`;
    const claimed: Execution = {
      ...next,
      protocol_version: PROTOCOL_VERSION,
      state: 'preparing',
      attempt: (this.runs.get(next.id)?.attempt ?? next.attempt ?? 0) + 1,
      // Results a previous attempt reported survive a reclaim.
      results: { ...(this.runs.get(next.id)?.results ?? next.results ?? {}) },
      lease_token: leaseToken,
      lease_until: new Date(this.clock() + 3 * 60_000).toISOString(),
    };
    this.runs.set(claimed.id, claimed);
    this.leases.set(claimed.id, leaseToken);
    return { ...claimed };
  }

  private expired(executionId: string): boolean {
    const until = Date.parse(this.runs.get(executionId)?.lease_until ?? '');
    return Number.isNaN(until) ? false : this.clock() >= until;
  }

  async progress(
    executionId: string,
    leaseToken: string,
    body: ProgressBody
  ): Promise<ProgressResponse['execution']> {
    this.maybeFail('progress');
    this.progressCalls.push({ executionId, body });
    if (Object.keys(body).length === 0) this.heartbeats.push(executionId);

    const run = this.runs.get(executionId);
    if (!run) throw new StaleAttemptError('fake: no such execution');
    if (this.leases.get(executionId) !== leaseToken) {
      throw new StaleAttemptError('Lease expired or superseded; stop this attempt');
    }
    // A terminal state may be acknowledged again with the same lease.
    if (
      ['ready_for_testing', 'failed', 'blocked', 'cancelled'].includes(run.state) &&
      body.state === run.state
    ) {
      return { ...run };
    }
    if (this.expired(executionId)) {
      throw new StaleAttemptError('Lease expired or superseded; stop this attempt');
    }
    if (this.cancelling.has(executionId) && body.state !== 'cancelled') {
      run.state = 'cancelling';
      return { ...run, cancel_requested: true };
    }
    if (!STAGES.includes(run.state) && run.state !== 'cancelling') {
      throw new StaleAttemptError('Execution is no longer active');
    }

    const state = body.state ?? run.state;
    if (state === 'cancelled' && run.state !== 'cancelling') {
      throw new Error('Cancellation was not requested');
    }
    if (
      STAGES.includes(state) &&
      STAGES.includes(run.state) &&
      STAGES.indexOf(state) < STAGES.indexOf(run.state)
    ) {
      throw new Error('Cannot move execution backwards');
    }
    if (body.message !== undefined && body.message.length > 2000) {
      throw new Error('Message must be at most 2000 characters');
    }

    if (body.repository_result) {
      const result = body.repository_result;
      if (!run.repositories.some((r) => r.id === result.repository_id)) {
        throw new Error('Repository is not part of this execution');
      }
      const problem = repositoryResultProblem(result);
      if (problem) throw new Error(problem);
      for (const url of result.pr_urls) {
        if (this.prBelongsElsewhere.has(url)) {
          throw new StaleAttemptError('PR does not belong to this result repository');
        }
        this.attachedPrs.push(url);
      }
      run.results[result.repository_id] = {
        outcome: result.outcome,
        tests: result.tests.map((t) => ({ command: t.command, exit_code: 0 })),
        base_commit: result.base_commit,
        head_commit: result.head_commit,
        pr_urls: result.pr_urls,
        attempt: run.attempt,
      };
    }

    if (state === 'ready_for_testing') {
      const missing = run.repositories.filter((r) => !run.results[r.id]);
      if (missing.length > 0) throw new Error('Every selected repository needs a verified result');
    }

    run.state = state;
    if (body.message) run.message = body.message;
    const terminal = !STAGES.includes(state);
    run.lease_until = terminal ? null : new Date(this.clock() + 3 * 60_000).toISOString();
    return { ...run };
  }
}
