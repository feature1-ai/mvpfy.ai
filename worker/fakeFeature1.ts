import {
  Assignment,
  AttachPrRequest,
  AttachPrResponse,
  BlockedRequest,
  CONTRACT_VERSION,
  ClaimRequest,
  ClaimResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  ProgressRequest,
  PrOwnerRef,
  RegisterRequest,
  RegisterResponse,
  ReleaseRequest,
  ResultRequest,
  StaleAttemptError,
  TransientTransportError,
} from '../shared/runner/contract';
import { Feature1Transport } from './transport';

/**
 * Feature1, as far as the worker can tell.
 *
 * Not a mock with canned returns: it keeps the state the real server would
 * have to keep — which attempt is live, which idempotency keys it has already
 * seen, where each pull request was attached — because the worker's hardest
 * behaviour is what it does when that state disagrees with its own. A fake
 * that always says yes would let every one of those bugs through.
 *
 * It is also the local development server: a worker pointed at this one runs
 * the whole execution path without Feature1 existing.
 */
export class FakeFeature1 implements Feature1Transport {
  /** Work waiting to be claimed. */
  private queue: Assignment[] = [];
  /** The attempt token the server considers live, per execution. */
  private liveToken = new Map<string, string>();
  /** assignmentId → executionId, recorded when the work is offered. */
  private executionFor = new Map<string, string>();
  private cancelled = new Set<string>();
  private draining = false;
  private leases = new Map<string, string>();

  /** Everything the worker sent, in order. Tests read this. */
  readonly progressCalls: ProgressRequest[] = [];
  readonly blockedCalls: BlockedRequest[] = [];
  readonly resultCalls: ResultRequest[] = [];
  readonly attachCalls: AttachPrRequest[] = [];
  readonly releaseCalls: ReleaseRequest[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  private seenKeys = new Set<string>();

  /** Make the next N calls of a kind fail as though the network dropped. */
  failNext: Partial<Record<keyof Feature1Transport, number>> = {};
  /**
   * Where the server says a pull request belongs, when it disagrees with the
   * worker. Keyed by executionId. Used to exercise the conflict path.
   */
  attachOverride = new Map<string, PrOwnerRef>();

  offer(...assignments: Assignment[]): void {
    for (const assignment of assignments) {
      this.queue.push(assignment);
      this.executionFor.set(assignment.assignmentId, assignment.executionId);
      this.liveToken.set(assignment.executionId, assignment.attemptToken);
      this.leases.set(assignment.assignmentId, assignment.leaseExpiresAt);
    }
  }

  /** Hand the execution to a newer attempt, as a reassignment would. */
  supersede(executionId: string, newToken: string): void {
    this.liveToken.set(executionId, newToken);
  }

  cancel(assignmentId: string): void {
    this.cancelled.add(assignmentId);
  }

  drain(): void {
    this.draining = true;
  }

  /** How many times a given idempotency key was accepted as new. */
  private accepted = new Map<string, number>();
  acceptedCount(key: string): number {
    return this.accepted.get(key) ?? 0;
  }

  private maybeFail(kind: keyof Feature1Transport): void {
    const left = this.failNext[kind] ?? 0;
    if (left > 0) {
      this.failNext[kind] = left - 1;
      throw new TransientTransportError(`fake: ${kind} is failing on purpose`);
    }
  }

  /**
   * Refuse a write from an attempt that is no longer the live one.
   *
   * This is the fencing check the real server has to make. Without it two
   * workers that both believe they hold the execution will both report, and
   * the later-arriving one wins by accident.
   */
  private checkToken(executionId: string, attemptToken: string): void {
    const live = this.liveToken.get(executionId);
    if (live && live !== attemptToken) {
      throw new StaleAttemptError(
        `attempt ${attemptToken} is not the live attempt for ${executionId}`
      );
    }
  }

  /** True the first time a key is seen; recorded either way. */
  private firstTime(key: string): boolean {
    this.accepted.set(key, (this.accepted.get(key) ?? 0) + 1);
    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    return true;
  }

  private executionOf(assignmentId: string): string {
    const executionId = this.executionFor.get(assignmentId);
    if (!executionId) throw new Error(`fake: no assignment ${assignmentId} was ever offered`);
    return executionId;
  }

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    this.maybeFail('register');
    return {
      runnerId: `runner-for-${req.name.replace(/\W+/g, '-').toLowerCase()}`,
      runnerToken: 'fake-runner-token',
      contractVersion: CONTRACT_VERSION,
    };
  }

  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    this.maybeFail('heartbeat');
    this.heartbeats.push(req);
    const cancel = req.running
      .filter((r) => this.cancelled.has(r.assignmentId))
      .map((r) => r.assignmentId);
    const leases: Record<string, string> = {};
    for (const running of req.running) {
      const lease = this.leases.get(running.assignmentId);
      if (lease) leases[running.assignmentId] = lease;
    }
    return { cancel, drain: this.draining, leases };
  }

  async claim(req: ClaimRequest): Promise<ClaimResponse> {
    this.maybeFail('claim');
    if (this.draining || req.capacity <= 0) return { assignments: [] };
    return { assignments: this.queue.splice(0, req.capacity) };
  }

  async progress(req: ProgressRequest): Promise<void> {
    this.maybeFail('progress');
    this.checkToken(this.executionOf(req.assignmentId), req.attemptToken);
    if (this.firstTime(req.idempotencyKey)) this.progressCalls.push(req);
  }

  async blocked(req: BlockedRequest): Promise<void> {
    this.maybeFail('blocked');
    this.checkToken(this.executionOf(req.assignmentId), req.attemptToken);
    if (this.firstTime(req.idempotencyKey)) this.blockedCalls.push(req);
  }

  async result(req: ResultRequest): Promise<void> {
    this.maybeFail('result');
    this.checkToken(this.executionOf(req.assignmentId), req.attemptToken);
    if (this.firstTime(req.idempotencyKey)) this.resultCalls.push(req);
  }

  async attachPr(req: AttachPrRequest): Promise<AttachPrResponse> {
    this.maybeFail('attachPr');
    this.checkToken(req.executionId, req.attemptToken);
    if (this.firstTime(req.idempotencyKey)) this.attachCalls.push(req);
    // Feature1 resolves ownership; the worker's expectation is only a check.
    return { attachedTo: this.attachOverride.get(req.executionId) ?? req.expectedOwner };
  }

  async release(req: ReleaseRequest): Promise<void> {
    this.maybeFail('release');
    this.releaseCalls.push(req);
    this.leases.delete(req.assignmentId);
  }
}
