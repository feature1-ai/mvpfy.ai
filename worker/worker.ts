import { Execution, StaleAttemptError } from '../shared/runner/contract';
import { Feature1Transport } from './transport';
import { ExecutionCheckpoint, ExecutionStore, freshCheckpoint } from './store';
import { ExecutionEngine } from './engine';
import { Redactor } from './redact';

/**
 * The loop.
 *
 * Claims one execution at a time, heartbeats while it works, and gives
 * everything back cleanly when told to stop. No Electron, no window, no
 * React: plain node, and the only thing it listens on is nothing at all —
 * every connection is outbound.
 *
 * There is no registration step. A Feature1 organisation admin mints a
 * runner credential out of band and the operator injects it; the worker
 * simply starts using it. That credential expires after 24 hours, which is
 * the single most surprising thing about operating one of these, so the
 * worker says so plainly when it is refused rather than looking like an
 * outage.
 *
 * Concurrency is one. Feature1's claim hands out a single execution per
 * call and enforces one active run per artifact owner, so a worker holding
 * several would be several leases to keep alive against a three-minute
 * clock for no gain. If that changes, this is where it changes.
 */

export interface WorkerOptions {
  name: string;
  /** Milliseconds between claim attempts when idle. */
  claimIntervalMs: number;
  /** Milliseconds between heartbeats. The lease is three minutes. */
  heartbeatIntervalMs: number;
}

export interface WorkerDeps {
  transport: Feature1Transport;
  store: ExecutionStore;
  redactor: Redactor;
  engine: ExecutionEngine;
  options: WorkerOptions;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class Worker {
  private current: { execution: Execution; controller: AbortController } | null = null;
  private draining = false;
  private stopped = false;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: WorkerDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private log(message: string): void {
    this.deps.log?.(this.deps.redactor.line(message, 500));
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /**
   * Finish anything that was in flight when this worker last stopped.
   *
   * An execution whose terminal state Feature1 never accepted is not
   * finished, whatever happened to the process — and resuming it is the
   * only thing that stops a second pull request, because the checkpoint
   * remembers the one already open.
   *
   * The lease, though, is almost certainly gone: it lasts three minutes and
   * a restart takes longer than that. So the work is not resumed from the
   * checkpoint directly; it is left for Feature1 to hand back on a claim,
   * which it does because an expired lease makes the run reclaimable. What
   * recovery buys is the checkpoint being there when it comes back.
   */
  recoverable(): ExecutionCheckpoint[] {
    return this.deps.store.unfinished();
  }

  /** One pass: claim if idle, and run what we get. */
  async tick(): Promise<void> {
    if (this.stopped || this.draining || this.current) return;
    let execution: Execution | null;
    try {
      execution = await this.deps.transport.claim();
    } catch (error) {
      this.log(`claim failed: ${(error as Error).message}`);
      return;
    }
    if (!execution) return;
    await this.runOne(execution);
  }

  private async runOne(execution: Execution): Promise<void> {
    // A checkpoint from an earlier attempt carries the pull requests and
    // results already produced. Reused when it is the same execution, so a
    // reclaimed run continues rather than starting over.
    const existing = this.deps.store.load(execution.tenant_id, execution.id);
    const checkpoint =
      existing && !existing.reported
        ? { ...existing, execution, state: execution.state }
        : freshCheckpoint(execution);
    this.deps.store.save(checkpoint);
    if (existing && !existing.reported) {
      this.log(`${execution.id}: continuing attempt ${execution.attempt} from a saved checkpoint`);
    }

    const controller = new AbortController();
    this.current = { execution, controller };
    const beating = this.keepAlive(checkpoint, controller);
    try {
      const ending = await this.deps.engine.run(checkpoint, controller.signal);
      this.log(`${execution.id} finished: ${ending}`);
    } catch (error) {
      if (error instanceof StaleAttemptError) {
        // Somebody else holds it now. The work stays on disk; Feature1 will
        // hand it back, to us or to another worker, with the results that
        // were already accepted.
        this.log(`${execution.id}: ${error.message}`);
      } else {
        this.log(`${execution.id} ended badly: ${(error as Error).message}`);
      }
    } finally {
      controller.abort();
      await beating;
      this.current = null;
    }
  }

  /**
   * Keep the lease alive while the agent works.
   *
   * The lease is three minutes and a story can take far longer than that,
   * so without this every long execution would be reclaimed mid-flight.
   * The same call also carries the cancellation flag back, which is why a
   * cancel reaches an agent that is deep in a build rather than waiting for
   * it to finish.
   */
  private async keepAlive(
    checkpoint: ExecutionCheckpoint,
    controller: AbortController
  ): Promise<void> {
    while (!controller.signal.aborted) {
      await this.sleep(this.deps.options.heartbeatIntervalMs);
      if (controller.signal.aborted) return;
      try {
        const { cancelRequested } = await this.deps.engine.beat(checkpoint);
        if (cancelRequested) {
          this.log(`${checkpoint.execution.id}: cancellation requested`);
          controller.abort();
          return;
        }
      } catch (error) {
        if (error instanceof StaleAttemptError) {
          // The lease is gone. Stop the agent now rather than letting it
          // keep writing to a checkout somebody else may reclaim.
          this.log(`${checkpoint.execution.id}: lease lost while working`);
          controller.abort();
          return;
        }
        this.log(`heartbeat failed: ${(error as Error).message}`);
      }
    }
  }

  /** Stop one execution. The engine reports it as cancelled. */
  cancel(): void {
    this.current?.controller.abort();
  }

  /**
   * Stop claiming, let what is running finish, then return.
   *
   * `force` is for the second signal, usually because the container is
   * going away regardless. Even then the execution is cancelled rather than
   * abandoned, so it reports — an execution killed halfway leaves a branch
   * pushed and nothing said about it, which is the state that costs a
   * person the most time to untangle.
   */
  async shutdown(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    this.draining = true;
    this.stopped = true;
    if (!this.current) return;
    if (opts.force) this.cancel();
    this.log('waiting for the execution in flight to finish');
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    while (this.current && Date.now() < deadline) {
      await this.sleep(50);
    }
    if (this.current) {
      this.log('it did not finish in time; cancelling it');
      this.cancel();
      while (this.current) await this.sleep(50);
    }
  }

  /** Run until stopped. */
  async loop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (this.stopped) return;
      await this.sleep(this.deps.options.claimIntervalMs);
    }
  }
}
