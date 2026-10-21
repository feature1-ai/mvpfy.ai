/**
 * The contract between a mvpfy worker and Feature1, as mvpfy proposes it.
 *
 * NOTHING HERE IS CONFIRMED. Feature1's execution API is being built
 * separately, and no operation named in this file has been called against a
 * real server. The names are mvpfy's proposal; the shapes are what a worker
 * genuinely needs in order to be safe, and those are the part worth arguing
 * about. `docs/runner-contract-v1.md` says the same thing in prose, and
 * `docs/feature1-handoff.md` lists what the other side has to provide.
 *
 * The worker therefore never calls an endpoint unless it has been given one
 * explicitly (see `worker/httpTransport.ts`), and every test in this
 * repository runs against the in-process fake. A green test suite here is
 * evidence that the worker behaves, not that the integration works.
 */

/** Bumped when a field changes meaning. Sent on every request. */
export const CONTRACT_VERSION = 'mvpfy.runner/2026-10-21';

// -- Identity ---------------------------------------------------------------

/**
 * What Feature1 asked for. The worker never decides this: a task that belongs
 * to a story that belongs to a feature is a `task` here, and which artifact
 * the pull request hangs off is a separate question with a separate field.
 */
export type ArtifactType = 'feature' | 'story' | 'task';

export interface ArtifactRef {
  type: ArtifactType;
  id: string;
  /** Human reference (FEA-142, US-03). Display only; never an identifier. */
  code?: string;
  title?: string;
}

/**
 * Where the pull request hangs, decided by Feature1 and not by the worker.
 *
 * The rules are Feature1's: a feature, or a story or task belonging to one,
 * all roll up to the feature; a standalone story owns its own; a task under a
 * standalone story rolls up to that story; a standalone task owns its own.
 * The worker carries the answer rather than deriving it, because deriving it
 * requires knowing a hierarchy the worker is not told and must not guess.
 */
export interface PrOwnerRef {
  type: ArtifactType;
  id: string;
}

// -- What to build ----------------------------------------------------------

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface WorkItem {
  id: string;
  type: ArtifactType;
  code?: string;
  title: string;
  description?: string;
  acceptanceCriteria: AcceptanceCriterion[];
  /** Ids of items in this same snapshot that must be built first. */
  dependsOn?: string[];
  /** A task may carry literal steps; a story normally does not. */
  executionSteps?: string[];
}

/**
 * The requirements as they stood when the assignment was made.
 *
 * Immutable and revisioned on purpose: an execution that reports success has
 * to be able to say which text it was judged against, and Feature1 may have
 * moved on. A revision that does not match a resumed execution's checkpoint
 * is a new attempt, not a continuation.
 */
export interface RequirementsSnapshot {
  revision: string;
  title: string;
  description?: string;
  /**
   * Acceptance criteria for the artifact itself. A standalone story or task
   * carries its own here and needs no further planning — mvpfy must not make
   * a standalone item write a feature PRD before it can start.
   */
  acceptanceCriteria: AcceptanceCriterion[];
  /** Selected stories/tasks under a feature, in dependency order. */
  items: WorkItem[];
}

// -- Where to build it ------------------------------------------------------

/**
 * A repository the assignment authorises. The id is stable and is what every
 * path, branch record and result is keyed by — never the basename, because
 * two repositories in one assignment may share one.
 */
export interface RepositoryRef {
  repositoryId: string;
  /** Display name. Not unique, not an identifier. */
  name: string;
  cloneUrl: string;
  baseBranch: string;
  /** The commit the requirements were written against. */
  baseCommit: string;
}

export type VerificationKind = 'test' | 'lint' | 'build' | 'typecheck' | 'other';

export interface VerificationStep {
  id: string;
  kind: VerificationKind;
  /** Shown to a person. */
  name: string;
  command: string;
  /** Which repository's checkout to run it in. */
  repositoryId: string;
  /** A failure here does not fail the execution, but is still reported. */
  optional?: boolean;
  timeoutMs?: number;
}

export interface VerificationSpec {
  steps: VerificationStep[];
  /**
   * When Feature1 supplies no steps, the worker may discover them from the
   * repository. Discovery is reported as such, because "tests passed" from a
   * command nobody specified is a weaker claim than one that was asked for.
   */
  allowDiscovery?: boolean;
}

/** What is being asked of this attempt. */
export type ExecutionStage = 'implement' | 'revise';

// -- The assignment ---------------------------------------------------------

export interface Assignment {
  contractVersion: string;
  assignmentId: string;
  executionId: string;
  attemptId: string;
  /**
   * The fencing token. Rises with each attempt. Every write-shaped call
   * carries it, and a server that has handed the execution to a newer attempt
   * rejects the older one rather than letting two workers both report.
   */
  attemptToken: string;
  tenantId: string;
  projectId: string;
  artifact: ArtifactRef;
  prOwner: PrOwnerRef;
  requirements: RequirementsSnapshot;
  repositories: RepositoryRef[];
  stage: ExecutionStage;
  verification: VerificationSpec;
  /** ISO 8601. The worker stops publishing once this passes unrenewed. */
  leaseExpiresAt: string;
}

// -- What the worker reports ------------------------------------------------

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

/** States from which no further work happens without a new assignment. */
export const TERMINAL_STATES: readonly ExecutionState[] = [
  'ready_for_testing',
  'blocked',
  'failed',
  'cancelled',
];

export function isTerminal(state: ExecutionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export type VerificationOutcome = 'passed' | 'failed' | 'skipped' | 'unavailable';

export interface VerificationResult {
  stepId: string;
  kind: VerificationKind;
  name: string;
  command: string;
  repositoryId: string;
  outcome: VerificationOutcome;
  exitCode: number | null;
  durationMs: number;
  /** One line a person can read. Redacted before it leaves the worker. */
  summary: string;
  /**
   * Why an outcome that is not pass/fail happened — the command was not
   * found, no test script exists, it timed out. A verification that could not
   * run is reported as such and never silently counted as a pass.
   */
  reason?: string;
  /** True when the worker chose this command rather than being given it. */
  discovered?: boolean;
}

export interface CommitRecord {
  sha: string;
  subject: string;
}

export interface PullRequestRecord {
  url: string;
  number: number;
  /** Owner and name as GitHub knows them, read back rather than assumed. */
  repositoryOwner: string;
  repositoryName: string;
  headBranch: string;
  baseBranch: string;
  /** False when this attempt found an existing pull request and reused it. */
  createdByThisAttempt: boolean;
}

export interface RepositoryResult {
  repositoryId: string;
  /** False means the agent touched nothing here. Not a failure. */
  changed: boolean;
  headBranch: string | null;
  headCommit: string | null;
  commits: CommitRecord[];
  verification: VerificationResult[];
  pullRequest: PullRequestRecord | null;
  /** Set when this repository did not finish. The others still report. */
  error?: string;
}

export type BlockedKind =
  | 'component_missing'
  | 'tenant_unknown'
  | 'setup_question'
  | 'conflict_unresolved'
  | 'agent_unavailable'
  | 'requirements_unclear'
  | 'repository_unavailable';

export interface BlockedQuestion {
  id: string;
  kind: BlockedKind;
  text: string;
  options?: string[];
}

// -- Operations -------------------------------------------------------------

export interface RegisterRequest {
  contractVersion: string;
  name: string;
  workerVersion: string;
  capabilities: {
    agents: string[];
    concurrency: number;
    /** Repository ids this worker already holds a clone of. */
    repositories: string[];
  };
}

export interface RegisterResponse {
  runnerId: string;
  runnerToken: string;
  /** Server's contract version, so a mismatch is caught at registration. */
  contractVersion: string;
}

export interface HeartbeatRequest {
  contractVersion: string;
  runnerId: string;
  status: 'idle' | 'working' | 'draining';
  running: Array<{ assignmentId: string; attemptToken: string; state: ExecutionState }>;
}

export interface HeartbeatResponse {
  /** Assignments the server wants abandoned. */
  cancel: string[];
  /** Stop claiming new work. */
  drain: boolean;
  /** Renewed expiry per assignment still held. */
  leases: Record<string, string>;
}

export interface ClaimRequest {
  contractVersion: string;
  runnerId: string;
  /** How many more the worker will take right now. */
  capacity: number;
}

export interface ClaimResponse {
  assignments: Assignment[];
}

export interface ProgressRequest {
  contractVersion: string;
  runnerId: string;
  assignmentId: string;
  attemptToken: string;
  state: ExecutionState;
  /** One plain sentence for a product manager. */
  detail: string;
  /** Deterministic, so a retried send is not a second event. */
  idempotencyKey: string;
  repositories?: RepositoryResult[];
}

export interface BlockedRequest {
  contractVersion: string;
  runnerId: string;
  assignmentId: string;
  attemptToken: string;
  questions: BlockedQuestion[];
  idempotencyKey: string;
}

export type ExecutionOutcome = 'ready_for_testing' | 'failed' | 'cancelled' | 'blocked';

export interface ResultRequest {
  contractVersion: string;
  runnerId: string;
  assignmentId: string;
  attemptToken: string;
  outcome: ExecutionOutcome;
  /** One sentence. Never a log, never a credential. */
  summary: string;
  repositories: RepositoryResult[];
  requirementsRevision: string;
  idempotencyKey: string;
}

/**
 * Attach one pull request to the artifact Feature1 says owns it.
 *
 * Explicit ids on every call. The existing MCP `attach_pr` hangs the pull
 * request off whatever workflow the shared session happens to be pointing at,
 * which is unusable from a worker running several executions at once — two
 * concurrent attaches would race and the loser would attach to the wrong
 * artifact without either side noticing.
 */
export interface AttachPrRequest {
  contractVersion: string;
  runnerId: string;
  executionId: string;
  attemptToken: string;
  /** Where the worker was told it belongs. */
  expectedOwner: PrOwnerRef;
  /** Where the work actually came from, kept for traceability. */
  originArtifact: ArtifactRef;
  pullRequest: PullRequestRecord;
  idempotencyKey: string;
}

export interface AttachPrResponse {
  /** Where Feature1 actually attached it. Authoritative. */
  attachedTo: PrOwnerRef;
}

export interface ReleaseRequest {
  contractVersion: string;
  runnerId: string;
  assignmentId: string;
  attemptToken: string;
  reason: string;
}

// -- Errors the worker must tell apart --------------------------------------

/**
 * The attempt is no longer the live one. Distinct from a transport failure,
 * because the repair is the opposite: a transport failure is retried, and
 * this must never be.
 */
export class StaleAttemptError extends Error {
  constructor(message = 'This attempt is no longer the live one') {
    super(message);
    this.name = 'StaleAttemptError';
  }
}

/** The server does not speak this contract version. */
export class ContractMismatchError extends Error {
  constructor(theirs: string) {
    super(`Feature1 speaks ${theirs}; this worker speaks ${CONTRACT_VERSION}`);
    this.name = 'ContractMismatchError';
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
