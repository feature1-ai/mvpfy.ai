import {
  Assignment,
  CONTRACT_VERSION,
  ExecutionState,
  StaleAttemptError,
} from '../shared/runner/contract';
import { Feature1Transport, withRetry } from './transport';
import { ExecutionCheckpoint, ExecutionStore, freshCheckpoint } from './store';
import { LeaseGuard } from './lease';
import { ExecutionEngine } from './engine';
import { Redactor } from './redact';

/**
 * The loop.
 *
 * Registers, then claims what it has capacity for, heartbeats while it
 * works, and gives everything back cleanly when told to stop. No Electron,
 * no window, no React: this runs under plain node, and the only thing it
 * listens on is nothing at all — every connection is outbound.
 *
 * Draining deserves a word. A worker told to stop does not abandon what it
 * is holding: it stops claiming, finishes what is in flight, and only then
 * exits. Killing an execution halfway leaves a branch pushed and no result
 * reported, which is the state that costs a person the most time to
 * untangle.
 */

export interface WorkerOptions {
  name: string;
  workerVersion: string;
  tenantId: string;
  concurrency: number;
  claimIntervalMs: number;
  heartbeatIntervalMs: number;
  agents: string[];
}

export interface WorkerDeps {
  transport: Feature1Transport;
  store: ExecutionStore;
  redactor: Redactor;
  /** Built per execution, so each gets its own cancellation. */
  makeEngine: (runnerId: string) => ExecutionEngine;
  options: WorkerOptions;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface InFlight {
  assignment: Assignment;
  checkpoint: ExecutionCheckpoint;
  lease: LeaseGuard;
  controller: AbortController;
  done: Promise<void>;
}

export class Worker {
  private runnerId = '';
  private readonly inFlight = new Map<string, InFlight>();
  private draining = false;
  private stopped = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: WorkerDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  private log(message: string): void {
    this.deps.log?.(this.deps.redactor.line(message, 500));
  }

  get running(): number {
    return this.inFlight.size;
  }

  async register(): Promise<void> {
    const res = await withRetry(() =>
      this.deps.transport.register({
        contractVersion: CONTRACT_VERSION,
        name: this.deps.options.name,
        workerVersion: this.deps.options.workerVersion,
        capabilities: {
          agents: this.deps.options.agents,
          concurrency: this.deps.options.concurrency,
          repositories: [],
        },
      })
    );
    this.runnerId = res.runnerId;
    // The token is a credential and must never appear in a log or a result.
    this.deps.redactor.remember(res.runnerToken);
    this.log(`registered as ${res.runnerId}`);
  }

  /**
   * Pick up what was in flight when this worker last stopped.
   *
   * An execution whose result was never accepted is not finished, whatever
   * happened to the process. Resuming it is also the only way to avoid a
   * second pull request: the checkpoint remembers the one already open.
   */
  async recover(): Promise<number> {
    const unfinished = this.deps.store.unfinished();
    for (const checkpoint of unfinished) {
      if (checkpoint.assignment.tenantId !== this.deps.options.tenantId) continue;
      this.log(
        `resuming ${checkpoint.assignment.executionId} from ${checkpoint.state} after a restart`
      );
      this.start(checkpoint.assignment, checkpoint);
    }
    return this.inFlight.size;
  }

  private start(assignment: Assignment, existing?: ExecutionCheckpoint): void {
    const checkpoint = existing ?? freshCheckpoint(assignment, new Date(this.now()));
    this.deps.store.save(checkpoint, new Date(this.now()));
    const lease = new LeaseGuard(
      assignment.assignmentId,
      assignment.attemptToken,
      checkpoint.leaseExpiresAt,
      this.now
    );
    const controller = new AbortController();
    const engine = this.deps.makeEngine(this.runnerId);
    const done = engine
      .run(checkpoint, lease, controller.signal)
      .then((outcome) => {
        this.log(`${assignment.executionId} finished: ${outcome}`);
      })
      .catch((error) => {
        if (error instanceof StaleAttemptError) {
          this.log(`${assignment.executionId}: ${error.message}`);
          return;
        }
        this.log(`${assignment.executionId} ended badly: ${(error as Error).message}`);
      })
      .finally(() => {
        this.inFlight.delete(assignment.assignmentId);
      });
    this.inFlight.set(assignment.assignmentId, {
      assignment,
      checkpoint,
      lease,
      controller,
      done,
    });
  }

  /** One pass: heartbeat, obey what comes back, then claim if there is room. */
  async tick(): Promise<void> {
    await this.heartbeatOnce();
    if (this.draining || this.stopped) return;
    const capacity = Math.max(0, this.deps.options.concurrency - this.inFlight.size);
    if (capacity === 0) return;
    let assignments: Assignment[];
    try {
      const res = await this.deps.transport.claim({
        contractVersion: CONTRACT_VERSION,
        runnerId: this.runnerId,
        capacity,
      });
      assignments = res.assignments;
    } catch (error) {
      // A claim that failed is simply no work this pass. The next tick asks
      // again, and in the meantime anything already running is unaffected.
      this.log(`claim failed: ${(error as Error).message}`);
      return;
    }
    for (const assignment of assignments) {
      // One tenant per worker for now, and an assignment for another is a
      // scope violation rather than a surprise to absorb quietly.
      if (assignment.tenantId !== this.deps.options.tenantId) {
        this.log(
          `refusing ${assignment.assignmentId}: it belongs to tenant ${assignment.tenantId}, ` +
            `and this worker serves ${this.deps.options.tenantId}`
        );
        await this.deps.transport
          .release({
            contractVersion: CONTRACT_VERSION,
            runnerId: this.runnerId,
            assignmentId: assignment.assignmentId,
            attemptToken: assignment.attemptToken,
            reason: 'This worker serves a different tenant',
          })
          .catch(() => undefined);
        continue;
      }
      // Delivered twice is ordinary at-least-once behaviour. The second
      // delivery must not start a second attempt at the same execution.
      if (this.inFlight.has(assignment.assignmentId)) {
        this.log(`ignoring a repeat delivery of ${assignment.assignmentId}`);
        continue;
      }
      const onDisk = this.deps.store.load(assignment.tenantId, assignment.executionId);
      if (onDisk?.reported) {
        this.log(`${assignment.executionId} was already reported; releasing it`);
        await this.deps.transport
          .release({
            contractVersion: CONTRACT_VERSION,
            runnerId: this.runnerId,
            assignmentId: assignment.assignmentId,
            attemptToken: assignment.attemptToken,
            reason: 'Already completed by this worker',
          })
          .catch(() => undefined);
        continue;
      }
      // A checkpoint written against different requirements is a different
      // piece of work wearing the same execution id. Start again rather than
      // continuing against text nobody agreed to.
      const resumable =
        onDisk &&
        onDisk.assignment.requirements.revision === assignment.requirements.revision &&
        onDisk.assignment.attemptId === assignment.attemptId
          ? onDisk
          : undefined;
      this.start(assignment, resumable);
    }
  }

  private async heartbeatOnce(): Promise<void> {
    if (!this.runnerId) return;
    const running = [...this.inFlight.values()].map((f) => ({
      assignmentId: f.assignment.assignmentId,
      attemptToken: f.lease.attemptToken,
      state: f.checkpoint.state as ExecutionState,
    }));
    let res;
    try {
      res = await this.deps.transport.heartbeat({
        contractVersion: CONTRACT_VERSION,
        runnerId: this.runnerId,
        status: this.draining ? 'draining' : this.inFlight.size > 0 ? 'working' : 'idle',
        running,
      });
    } catch (error) {
      // A missed heartbeat is not by itself a reason to stop working: the
      // lease has not expired yet, and the next one may get through.
      this.log(`heartbeat failed: ${(error as Error).message}`);
      return;
    }
    if (res.drain && !this.draining) {
      this.log('Feature1 asked this worker to drain');
      this.draining = true;
    }
    for (const [assignmentId, expiry] of Object.entries(res.leases ?? {})) {
      this.inFlight.get(assignmentId)?.lease.renew(expiry);
    }
    for (const assignmentId of res.cancel ?? []) {
      this.cancel(assignmentId);
    }
  }

  /** Stop one execution. The engine reports it as cancelled. */
  cancel(assignmentId: string): void {
    const flight = this.inFlight.get(assignmentId);
    if (!flight) return;
    this.log(`cancelling ${assignmentId}`);
    flight.controller.abort();
  }

  /**
   * Stop claiming, let what is running finish, then return.
   *
   * `force` is for the second signal — the operator asking again, usually
   * because the container is about to be killed anyway. Even then the
   * executions are cancelled rather than abandoned, so each reports.
   */
  async shutdown(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
    this.draining = true;
    this.stopped = true;
    if (opts.force) {
      for (const assignmentId of [...this.inFlight.keys()]) this.cancel(assignmentId);
    }
    const inFlight = [...this.inFlight.values()].map((f) => f.done);
    if (inFlight.length === 0) return;
    this.log(`waiting for ${inFlight.length} execution(s) to finish`);
    const timeout = opts.timeoutMs ?? 10 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeout);
    });
    const outcome = await Promise.race([Promise.allSettled(inFlight).then(() => 'done'), expired]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      this.log('executions did not finish in time; cancelling them');
      for (const assignmentId of [...this.inFlight.keys()]) this.cancel(assignmentId);
      await Promise.allSettled([...this.inFlight.values()].map((f) => f.done));
    }
  }

  /** Run until stopped. Each pass heartbeats and then claims. */
  async loop(): Promise<void> {
    while (!this.stopped) {
      await this.tick();
      if (this.draining && this.inFlight.size === 0) {
        this.log('drained, and nothing is running');
        return;
      }
      await this.sleep(this.deps.options.claimIntervalMs);
    }
  }
}
