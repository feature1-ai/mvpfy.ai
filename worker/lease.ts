import { StaleAttemptError } from '../shared/runner/contract';

/**
 * The right to still be doing this.
 *
 * A worker holds an execution on a lease that the heartbeat renews. Two
 * things can end it: the lease runs out, or Feature1 hands the execution to a
 * newer attempt. Either way the worker must stop — and the dangerous moment
 * is not the one where it keeps working, which only wastes time, but the one
 * where it keeps *publishing*: pushing a branch, opening a pull request, or
 * reporting success for an execution somebody else now owns.
 *
 * So the guard is checked immediately before every publishing step rather
 * than once at the top. The gap between deciding to publish and publishing is
 * exactly where a reassignment lands.
 */
export class LeaseGuard {
  private expiresAt: number;
  private surrendered = false;

  constructor(
    readonly assignmentId: string,
    readonly attemptToken: string,
    leaseExpiresAt: string,
    private readonly now: () => number = Date.now
  ) {
    this.expiresAt = Date.parse(leaseExpiresAt);
    if (Number.isNaN(this.expiresAt)) {
      throw new Error(`leaseExpiresAt is not a date: ${leaseExpiresAt}`);
    }
  }

  /** Push the expiry out, as a heartbeat response does. */
  renew(leaseExpiresAt: string): void {
    const next = Date.parse(leaseExpiresAt);
    if (Number.isNaN(next)) return;
    // Never backwards: a stale heartbeat response arriving late must not
    // shorten a lease that has since been renewed.
    if (next > this.expiresAt) this.expiresAt = next;
  }

  /** Give it up deliberately — cancelled, superseded, shutting down. */
  surrender(): void {
    this.surrendered = true;
  }

  get live(): boolean {
    return !this.surrendered && this.now() < this.expiresAt;
  }

  /** Milliseconds left, floored at zero. For deciding whether to start a step. */
  get remainingMs(): number {
    return Math.max(0, this.expiresAt - this.now());
  }

  /**
   * Refuse to go on. Called before each publishing step, naming the step so
   * the log says what was not done rather than only that something was not.
   */
  assertLive(step: string): void {
    if (this.surrendered) {
      throw new StaleAttemptError(`${step} stopped: this worker gave up ${this.assignmentId}`);
    }
    if (!this.live) {
      throw new StaleAttemptError(
        `${step} stopped: the lease on ${this.assignmentId} expired before it ran`
      );
    }
  }
}
