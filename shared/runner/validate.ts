import {
  ArtifactType,
  Execution,
  ExecutionRepository,
  ExecutionState,
  PROTOCOL_VERSION,
  ProtocolMismatchError,
  RepositoryResult,
  Snapshot,
  VerificationRecord,
} from './contract';

/**
 * Everything arriving from Feature1 is parsed before it is believed, and
 * everything leaving is checked before it is sent.
 *
 * Both directions, for different reasons. Inbound, an execution decides
 * which repositories the worker touches and which branches it pushes — a
 * field taken on trust is a field a mistaken or compromised server can use
 * to point the worker somewhere nobody authorised. Outbound, the server
 * rejects a malformed result with a 400 that costs an attempt, so the worker
 * would rather find the mistake before spending one.
 */

function obj(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function str(row: Record<string, unknown>, key: string, where: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const ARTIFACT_TYPES: readonly string[] = ['feature', 'story', 'task'];
const STATES: readonly string[] = [
  'queued',
  'preparing',
  'implementing',
  'verifying',
  'opening_prs',
  'ready_for_testing',
  'blocked',
  'failed',
  'cancelling',
  'cancelled',
];

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Feature1 keys everything by UUID, and so does the worker's disk layout. */
export function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A commit sha as the server will accept it: 40–64 hex. */
export function validCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
}

/**
 * A git ref the worker will put in a command.
 *
 * Narrower than git's own rules, and deliberately the same shape Feature1
 * validates a base branch with, so a branch it accepted cannot be one the
 * worker then refuses.
 */
export function validRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 200) return false;
  if (text.includes('..') || text.endsWith('/') || text.startsWith('-')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(text);
}

/**
 * A clone URL the worker is willing to hand to git.
 *
 * https and ssh only, and no embedded credentials — Feature1 refuses to
 * register a repository whose URL carries them, and the worker refuses to
 * use one for the same reason: it would end up in a process list.
 */
export function validCloneUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (/[@]/.test(text.split('://')[1] ?? '') && /^(https|ssh):\/\//.test(text)) {
    // scheme://user:pass@host — the form Feature1 rejects.
    const afterScheme = text.split('://')[1] ?? '';
    if (/^[^/]*:[^/]*@/.test(afterScheme)) return false;
  }
  if (/^https:\/\/[^\s/@]+(:[0-9]+)?\/[^\s]+$/.test(text)) return true;
  if (/^ssh:\/\/[A-Za-z0-9._-]+@[^\s/]+\/[^\s]+$/.test(text)) return true;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(text);
}

/**
 * A pull request URL in exactly the form Feature1 will accept.
 *
 * Checked here as well as there because the server rejects the whole result
 * if one is wrong, and a rejected result costs an attempt and a lease.
 */
export function validPullRequestUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(url.pathname.replace(/\/$/, ''));
}

function parseSnapshot(raw: unknown, where: string): Snapshot {
  const row = obj(raw, where);
  const type = str(row, 'type', where);
  if (!ARTIFACT_TYPES.includes(type)) throw new Error(`${where}.type is not an artifact type`);
  const stories = Array.isArray(row.stories)
    ? row.stories.map((s, i) => parseSnapshot(s, `${where}.stories[${i}]`))
    : undefined;
  return {
    type: type as ArtifactType,
    id: str(row, 'id', where),
    code: optionalStr(row, 'code'),
    title: optionalStr(row, 'title'),
    description: optionalStr(row, 'description'),
    acceptanceCriteria: Array.isArray(row.acceptanceCriteria)
      ? (row.acceptanceCriteria as Snapshot['acceptanceCriteria'])
      : [],
    executionSteps: Array.isArray(row.executionSteps)
      ? row.executionSteps.filter((s): s is string => typeof s === 'string')
      : [],
    taskGoal: optionalStr(row, 'taskGoal'),
    ...(row.requirements !== undefined ? { requirements: row.requirements } : {}),
    dependencies: Array.isArray(row.dependencies) ? row.dependencies : [],
    ...(stories ? { stories } : {}),
    instructions: typeof row.instructions === 'string' ? row.instructions : '',
    digest: str(row, 'digest', where),
    revision: optionalStr(row, 'revision'),
  };
}

function parseRepository(raw: unknown, index: number): ExecutionRepository {
  const where = `execution.repositories[${index}]`;
  const row = obj(raw, where);
  const id = str(row, 'id', where);
  // It becomes a directory name and the key of every result.
  if (!validUuid(id)) throw new Error(`${where}.id must be a UUID`);
  const url = str(row, 'url', where);
  if (!validCloneUrl(url)) throw new Error(`${where}.url is not a credential-free git URL`);
  const baseBranch = str(row, 'base_branch', where);
  if (!validRef(baseBranch)) throw new Error(`${where}.base_branch is not a usable ref`);
  return { id, name: str(row, 'name', where), url, base_branch: baseBranch };
}

/**
 * Parse a claimed execution, or refuse it with a reason naming the field.
 *
 * A refusal is reported back as `failed` rather than dropped: a worker that
 * silently ignores work it cannot read looks exactly like a worker that is
 * not running.
 */
export function parseExecution(raw: unknown): Execution {
  const row = obj(raw, 'execution');
  const protocol = row.protocol_version;
  if (protocol !== PROTOCOL_VERSION) throw new ProtocolMismatchError(protocol);

  const repositories = Array.isArray(row.repositories)
    ? row.repositories.map(parseRepository)
    : (() => {
        throw new Error('execution.repositories must be an array');
      })();
  if (repositories.length === 0) throw new Error('execution.repositories names none');
  const seen = new Set<string>();
  for (const repo of repositories) {
    if (seen.has(repo.id)) throw new Error(`execution.repositories repeats ${repo.id}`);
    seen.add(repo.id);
  }

  const state = str(row, 'state', 'execution');
  if (!STATES.includes(state)) throw new Error(`execution.state is not a known state: ${state}`);
  const originType = str(row, 'origin_type', 'execution');
  const ownerType = str(row, 'owner_type', 'execution');
  for (const [name, value] of [
    ['origin_type', originType],
    ['owner_type', ownerType],
  ] as const) {
    if (!ARTIFACT_TYPES.includes(value))
      throw new Error(`execution.${name} is not an artifact type`);
  }
  for (const key of ['id', 'tenant_id', 'project_id', 'origin_id', 'owner_id'] as const) {
    if (!validUuid(row[key])) throw new Error(`execution.${key} must be a UUID`);
  }

  const results: Record<string, Execution['results'][string]> = {};
  for (const [repositoryId, value] of Object.entries(obj(row.results ?? {}, 'execution.results'))) {
    // A result for a repository this execution does not hold is nonsense,
    // and acting on it would mean reporting about something unauthorised.
    if (!seen.has(repositoryId)) continue;
    results[repositoryId] = value as Execution['results'][string];
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    project_id: row.project_id as string,
    requested_by: String(row.requested_by ?? ''),
    origin_type: originType as ArtifactType,
    origin_id: row.origin_id as string,
    owner_type: ownerType as ArtifactType,
    owner_id: row.owner_id as string,
    assistant_thread_id: optionalStr(row, 'assistant_thread_id'),
    request_key: String(row.request_key ?? ''),
    snapshot: parseSnapshot(row.snapshot, 'execution.snapshot'),
    repositories,
    state: state as ExecutionState,
    attempt: Number.isFinite(Number(row.attempt)) ? Number(row.attempt) : 0,
    results,
    clarifications: Array.isArray(row.clarifications)
      ? (row.clarifications as Execution['clarifications']).filter(
          (c) => typeof c?.answer === 'string'
        )
      : [],
    message: optionalStr(row, 'message'),
    lease_token: str(row, 'lease_token', 'execution'),
    lease_until: optionalStr(row, 'lease_until'),
  };
}

/** The repository, or a refusal naming it. Scope is checked, never assumed. */
export function authorisedRepository(
  execution: Execution,
  repositoryId: string
): ExecutionRepository {
  const repo = execution.repositories.find((r) => r.id === repositoryId);
  if (!repo) {
    throw new Error(`Repository ${repositoryId} is not part of execution ${execution.id}`);
  }
  return repo;
}

/**
 * Check a repository result against the rules the server enforces, before
 * spending a lease finding out.
 *
 * Returns the reason it would be rejected, or null. The strictest of these
 * is worth stating plainly: **a result may only contain passing checks.**
 * There is no way to report a repository whose tests failed — that is a
 * failed execution with a message, not a result.
 */
export function repositoryResultProblem(result: RepositoryResult): string | null {
  if (!validUuid(result.repository_id)) return 'repository_id must be a UUID';
  if (result.outcome !== 'no_changes' && result.outcome !== 'pr_created') {
    return 'outcome must be no_changes or pr_created';
  }
  if (!validCommit(result.base_commit) || !validCommit(result.head_commit)) {
    return 'base_commit and head_commit must be 40–64 hex characters';
  }
  if (!Array.isArray(result.tests) || result.tests.length === 0 || result.tests.length > 100) {
    return 'between 1 and 100 verification commands are required';
  }
  for (const test of result.tests) {
    if (typeof test.command !== 'string' || !test.command.trim() || test.command.length > 1000) {
      return 'every verification command must be a string of at most 1000 characters';
    }
    if (test.exit_code !== 0) return 'only passing verification commands may be reported';
  }
  const urls = result.pr_urls ?? [];
  if (!Array.isArray(urls) || urls.length > 20) return 'at most 20 pull request URLs';
  if (result.outcome === 'pr_created' && urls.length === 0) {
    return 'pr_created needs at least one pull request URL';
  }
  if (result.outcome === 'no_changes') {
    if (urls.length > 0) return 'no_changes cannot carry pull request URLs';
    if (result.base_commit !== result.head_commit) {
      return 'no_changes needs identical base and head commits';
    }
  }
  for (const url of urls) {
    if (!validPullRequestUrl(url)) return `not a usable pull request URL: ${url}`;
  }
  return null;
}

/** Passing checks, in the shape the server stores. */
export function passingTests(
  commands: Array<{ command: string; exitCode: number | null }>
): VerificationRecord[] {
  return commands
    .filter((c) => c.exitCode === 0)
    .map((c) => ({ command: c.command.slice(0, 1000), exit_code: 0 }));
}

/**
 * The stories to build, in the order Feature1 sent them.
 *
 * Feature1 orders a feature's children by generation order and filters out
 * the finished ones before it ever reaches the worker, so there is no
 * dependency graph to solve here — which is a simplification the worker gets
 * for free and should not reinvent.
 */
export function unitsOf(execution: Execution): Snapshot[] {
  const stories = execution.snapshot.stories ?? [];
  return stories.length > 0 ? stories : [execution.snapshot];
}
