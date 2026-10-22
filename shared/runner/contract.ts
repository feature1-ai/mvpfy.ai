/**
 * The contract between a mvpfy worker and Feature1.
 *
 * AGREED AND IMPLEMENTED ON BOTH SIDES. This file used to hold mvpfy's
 * proposal; Feature1 has since shipped its execution API, and what follows is
 * that API rather than a suggestion about it. Where the two disagreed,
 * Feature1 won — it owns the queue, the requirements, and the decision about
 * which artifact a pull request belongs to.
 *
 * Feature1's own description of it lives in that repository, at
 * `docs/implementation/mvpfy-worker-v1.md`. `docs/runner-contract-v1.md`
 * here is the worker's side and records what changed from the proposal and
 * why.
 */

/** Sent by the server on every claim. A worker refuses anything else. */
export const PROTOCOL_VERSION = 1;

// -- Identity ---------------------------------------------------------------

/** What Feature1 asked for. */
export type ArtifactType = 'feature' | 'story' | 'task';

/**
 * Where the pull request hangs.
 *
 * Resolved by Feature1 and sent as `owner_type`/`owner_id`: a story or task
 * under a feature rolls up to the feature, a standalone one owns its own.
 * The worker carries the answer and never derives it — deriving it needs a
 * hierarchy the worker is not given. In practice the worker does not even
 * send it back: the server attaches pull requests itself and re-checks
 * ownership at the moment it does.
 */
export interface OwnerRef {
  type: ArtifactType;
  id: string;
}

// -- What to build ----------------------------------------------------------

export interface AcceptanceCriterion {
  id?: string;
  text?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * One artifact's requirements, as Feature1 froze them.
 *
 * A feature carries its PRD in `requirements` and its unfinished stories in
 * `stories`, in generation order. A standalone story or task carries its own
 * description and criteria and nothing else — it is built directly, and must
 * never be made to write a feature document first.
 */
export interface Snapshot {
  type: ArtifactType;
  id: string;
  code?: string | null;
  title?: string | null;
  description?: string | null;
  acceptanceCriteria?: AcceptanceCriterion[];
  executionSteps?: string[];
  taskGoal?: string | null;
  /** The approved PRD. Features only. */
  requirements?: unknown;
  dependencies?: unknown[];
  /** Child stories of a feature, already filtered to the unfinished ones. */
  stories?: Snapshot[];
  /** Free text the person typed when queueing. */
  instructions?: string;
  /** sha256 of the snapshot. Re-checked by the server before Testing. */
  digest: string;
  revision?: string | null;
}

/** A repository this execution authorises, as the run carries it. */
export interface ExecutionRepository {
  /** UUID. The only identifier — two may share a name. */
  id: string;
  name: string;
  url: string;
  base_branch: string;
}

/** An answer a person gave after a previous attempt stopped to ask. */
export interface Clarification {
  answer: string;
  at?: string;
}

/** What a previous attempt already finished, keyed by repository UUID. */
export interface RepositoryResultRecord {
  outcome: RepositoryOutcome;
  tests: VerificationRecord[];
  base_commit: string;
  head_commit: string;
  pr_urls: string[];
  attempt?: number;
}

// -- The claimed execution --------------------------------------------------

export type ExecutionState =
  | 'queued'
  | 'preparing'
  | 'implementing'
  | 'verifying'
  | 'opening_prs'
  | 'ready_for_testing'
  | 'blocked'
  | 'failed'
  | 'cancelling'
  | 'cancelled';

/** The stages a worker may report while it is still working, in order. */
export const STAGES: readonly ExecutionState[] = [
  'preparing',
  'implementing',
  'verifying',
  'opening_prs',
];

export const TERMINAL_STATES: readonly ExecutionState[] = [
  'ready_for_testing',
  'blocked',
  'failed',
  'cancelled',
];

export function isTerminal(state: ExecutionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface Execution {
  protocol_version: number;
  id: string;
  tenant_id: string;
  project_id: string;
  requested_by: string;
  origin_type: ArtifactType;
  origin_id: string;
  owner_type: ArtifactType;
  owner_id: string;
  assistant_thread_id: string | null;
  request_key: string;
  snapshot: Snapshot;
  repositories: ExecutionRepository[];
  state: ExecutionState;
  attempt: number;
  /** Results a previous attempt already reported. They survive a reclaim. */
  results: Record<string, RepositoryResultRecord>;
  clarifications: Clarification[];
  message: string | null;
  /**
   * The fencing token, returned only by claim. Sent on every progress call
   * in the `X-Execution-Lease` header, never in a body and never logged.
   */
  lease_token: string;
  /** ISO. Three minutes, extended by each successful progress call. */
  lease_until: string | null;
}

// -- What the worker reports ------------------------------------------------

/**
 * A repository outcome, and there are only two.
 *
 * Notably there is no "it failed" here. A repository result is a statement
 * that this repository is finished and its checks passed; a repository that
 * did not get there is reported by failing the execution instead, with a
 * message. The server enforces that — see VerificationRecord.
 */
export type RepositoryOutcome = 'no_changes' | 'pr_created';

/**
 * A check that ran and passed.
 *
 * The server rejects any result containing a non-zero `exit_code`, so this
 * type is only ever evidence of success. The worker's own richer record of
 * what ran, what failed and what could not run lives in its checkpoint and
 * in the pull request body.
 */
export interface VerificationRecord {
  command: string;
  exit_code: number;
}

export interface RepositoryResult {
  repository_id: string;
  outcome: RepositoryOutcome;
  /** 40–64 hex. Equal to head_commit when nothing changed. */
  base_commit: string;
  head_commit: string;
  /** At least one, all passing. */
  tests: VerificationRecord[];
  /** Empty for no_changes, at least one for pr_created, at most 20. */
  pr_urls: string[];
}

/** The body of a progress call. Everything is optional; `{}` is a heartbeat. */
export interface ProgressBody {
  state?: ExecutionState;
  /** One plain sentence for a product manager. At most 2000 characters. */
  message?: string;
  repository_result?: RepositoryResult;
}

export interface ProgressResponse {
  success: boolean;
  execution: Execution & {
    /** Set when somebody cancelled: stop, then acknowledge with `cancelled`. */
    cancel_requested?: boolean;
  };
}

export interface ClaimResponse {
  success: boolean;
  execution: Execution | null;
}

// -- Errors the worker must tell apart --------------------------------------

/**
 * The lease is gone: expired, or the execution was reclaimed by a newer
 * attempt. The server answers 409 and the worker MUST stop — not retry.
 * Retrying is how two workers end up both reporting on one execution.
 */
export class StaleAttemptError extends Error {
  constructor(message = 'Lease expired or superseded; stop this attempt') {
    super(message);
    this.name = 'StaleAttemptError';
  }
}

/** The server speaks a protocol this worker does not. */
export class ProtocolMismatchError extends Error {
  constructor(theirs: unknown) {
    super(
      `Feature1 sent protocol_version ${String(theirs)}; this worker speaks ${PROTOCOL_VERSION}`
    );
    this.name = 'ProtocolMismatchError';
  }
}

/** Reached the server, which refused. Retrying the same call will not help. */
export class PermanentTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'PermanentTransportError';
  }
}

/** Did not reach the server, or it failed in a way that may not recur. */
export class TransientTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientTransportError';
  }
}
