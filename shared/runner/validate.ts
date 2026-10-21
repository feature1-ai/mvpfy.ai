import {
  ArtifactType,
  Assignment,
  CONTRACT_VERSION,
  ContractMismatchError,
  ExecutionStage,
  RepositoryRef,
  VerificationKind,
  VerificationStep,
} from './contract';

/**
 * Everything arriving from Feature1 is parsed before it is believed.
 *
 * An assignment decides which repositories a worker clones, which commands it
 * runs to verify, and where it pushes. A field taken on trust is a field a
 * compromised or simply mistaken server can use to point the worker somewhere
 * it was never authorised to go — so the parse is strict, and a bad field is
 * a refusal rather than a default.
 */

function str(row: Record<string, unknown>, key: string, where: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStr(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arr(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

const ARTIFACT_TYPES: readonly string[] = ['feature', 'story', 'task'];
const STAGES: readonly string[] = ['implement', 'revise'];
const VERIFICATION_KINDS: readonly string[] = ['test', 'lint', 'build', 'typecheck', 'other'];

function artifactType(value: string, where: string): ArtifactType {
  if (!ARTIFACT_TYPES.includes(value)) {
    throw new Error(`${where} must be one of ${ARTIFACT_TYPES.join(', ')}`);
  }
  return value as ArtifactType;
}

/**
 * A clone URL the worker is willing to hand to git.
 *
 * https and ssh only. A `file://`, a bare local path or an `ext::` helper
 * would make the server able to read the worker's own disk or run a command
 * through git's transport helpers, which no legitimate assignment needs.
 */
export function validCloneUrl(value: string): boolean {
  const text = value.trim();
  if (/^https:\/\/[^\s/@]+(:[0-9]+)?\/[^\s]+$/.test(text)) return true;
  if (/^ssh:\/\/[^\s/@]+@[^\s/]+\/[^\s]+$/.test(text)) return true;
  // scp-style: git@github.com:owner/repo.git
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(text);
}

/**
 * A git ref name safe to put in a command and a path.
 *
 * Deliberately narrower than git's own rules: this ends up in shell commands
 * and in branch names the worker creates.
 */
export function validRef(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 255) return false;
  if (text.startsWith('-') || text.startsWith('/') || text.endsWith('/')) return false;
  if (text.includes('..') || text.includes('//')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(text);
}

/** A commit-ish the worker will check out. Full or abbreviated sha. */
export function validCommit(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

/**
 * An id used in a filesystem path. Stable, opaque, and never a basename —
 * two repositories in one assignment may well be called `api`.
 */
export function validId(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && text.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
}

function parseRepository(raw: unknown, index: number): RepositoryRef {
  const where = `repositories[${index}]`;
  const row = obj(raw, where);
  const repositoryId = str(row, 'repositoryId', where);
  if (!validId(repositoryId)) {
    throw new Error(`${where}.repositoryId is not a usable identifier: ${repositoryId}`);
  }
  const cloneUrl = str(row, 'cloneUrl', where);
  if (!validCloneUrl(cloneUrl)) {
    throw new Error(`${where}.cloneUrl is not an https or ssh git URL`);
  }
  const baseBranch = str(row, 'baseBranch', where);
  if (!validRef(baseBranch)) throw new Error(`${where}.baseBranch is not a usable ref`);
  const baseCommit = str(row, 'baseCommit', where);
  if (!validCommit(baseCommit)) throw new Error(`${where}.baseCommit is not a commit sha`);
  return { repositoryId, name: str(row, 'name', where), cloneUrl, baseBranch, baseCommit };
}

function parseVerificationStep(
  raw: unknown,
  index: number,
  repositoryIds: Set<string>
): VerificationStep {
  const where = `verification.steps[${index}]`;
  const row = obj(raw, where);
  const kind = str(row, 'kind', where);
  if (!VERIFICATION_KINDS.includes(kind)) {
    throw new Error(`${where}.kind must be one of ${VERIFICATION_KINDS.join(', ')}`);
  }
  const repositoryId = str(row, 'repositoryId', where);
  // A step pointed at a repository the assignment does not authorise would
  // run a server-chosen command in a checkout nobody granted.
  if (!repositoryIds.has(repositoryId)) {
    throw new Error(`${where}.repositoryId names a repository this assignment does not authorise`);
  }
  const timeout = row.timeoutMs;
  return {
    id: str(row, 'id', where),
    kind: kind as VerificationKind,
    name: str(row, 'name', where),
    command: str(row, 'command', where),
    repositoryId,
    ...(row.optional === true ? { optional: true } : {}),
    ...(typeof timeout === 'number' && timeout > 0 ? { timeoutMs: timeout } : {}),
  };
}

/**
 * Parse an assignment, or refuse it with a reason naming the field.
 *
 * A refused assignment is reported back as failed rather than dropped: a
 * worker that silently ignores work it cannot read looks identical to a
 * worker that is not running.
 */
export function parseAssignment(raw: unknown): Assignment {
  const row = obj(raw, 'assignment');
  const contractVersion = str(row, 'contractVersion', 'assignment');
  if (contractVersion !== CONTRACT_VERSION) throw new ContractMismatchError(contractVersion);

  const repositories = arr(row.repositories, 'assignment.repositories').map(parseRepository);
  if (repositories.length === 0) {
    throw new Error('assignment.repositories must name at least one repository');
  }
  const seen = new Set<string>();
  for (const repo of repositories) {
    if (seen.has(repo.repositoryId)) {
      throw new Error(`assignment.repositories repeats ${repo.repositoryId}`);
    }
    seen.add(repo.repositoryId);
  }

  const artifactRow = obj(row.artifact, 'assignment.artifact');
  const ownerRow = obj(row.prOwner, 'assignment.prOwner');
  const requirementsRow = obj(row.requirements, 'assignment.requirements');
  const verificationRow = obj(row.verification, 'assignment.verification');
  const stage = str(row, 'stage', 'assignment');
  if (!STAGES.includes(stage)) throw new Error(`assignment.stage must be implement or revise`);

  const executionId = str(row, 'executionId', 'assignment');
  if (!validId(executionId)) throw new Error('assignment.executionId is not a usable identifier');
  const tenantId = str(row, 'tenantId', 'assignment');
  if (!validId(tenantId)) throw new Error('assignment.tenantId is not a usable identifier');

  return {
    contractVersion,
    assignmentId: str(row, 'assignmentId', 'assignment'),
    executionId,
    attemptId: str(row, 'attemptId', 'assignment'),
    attemptToken: str(row, 'attemptToken', 'assignment'),
    tenantId,
    projectId: str(row, 'projectId', 'assignment'),
    artifact: {
      type: artifactType(
        str(artifactRow, 'type', 'assignment.artifact'),
        'assignment.artifact.type'
      ),
      id: str(artifactRow, 'id', 'assignment.artifact'),
      ...(optionalStr(artifactRow, 'code') ? { code: optionalStr(artifactRow, 'code') } : {}),
      ...(optionalStr(artifactRow, 'title') ? { title: optionalStr(artifactRow, 'title') } : {}),
    },
    prOwner: {
      type: artifactType(str(ownerRow, 'type', 'assignment.prOwner'), 'assignment.prOwner.type'),
      id: str(ownerRow, 'id', 'assignment.prOwner'),
    },
    requirements: {
      revision: str(requirementsRow, 'revision', 'assignment.requirements'),
      title: str(requirementsRow, 'title', 'assignment.requirements'),
      ...(optionalStr(requirementsRow, 'description')
        ? { description: optionalStr(requirementsRow, 'description') }
        : {}),
      acceptanceCriteria: arr(
        requirementsRow.acceptanceCriteria ?? [],
        'assignment.requirements.acceptanceCriteria'
      ).map((ac, i) => {
        const acRow = obj(ac, `assignment.requirements.acceptanceCriteria[${i}]`);
        return {
          id: str(acRow, 'id', `assignment.requirements.acceptanceCriteria[${i}]`),
          text: str(acRow, 'text', `assignment.requirements.acceptanceCriteria[${i}]`),
        };
      }),
      items: arr(requirementsRow.items ?? [], 'assignment.requirements.items').map((item, i) => {
        const where = `assignment.requirements.items[${i}]`;
        const itemRow = obj(item, where);
        return {
          id: str(itemRow, 'id', where),
          type: artifactType(str(itemRow, 'type', where), `${where}.type`),
          ...(optionalStr(itemRow, 'code') ? { code: optionalStr(itemRow, 'code') } : {}),
          title: str(itemRow, 'title', where),
          ...(optionalStr(itemRow, 'description')
            ? { description: optionalStr(itemRow, 'description') }
            : {}),
          acceptanceCriteria: arr(
            itemRow.acceptanceCriteria ?? [],
            `${where}.acceptanceCriteria`
          ).map((ac, j) => {
            const acRow = obj(ac, `${where}.acceptanceCriteria[${j}]`);
            return {
              id: str(acRow, 'id', `${where}.acceptanceCriteria[${j}]`),
              text: str(acRow, 'text', `${where}.acceptanceCriteria[${j}]`),
            };
          }),
          ...(Array.isArray(itemRow.dependsOn)
            ? { dependsOn: itemRow.dependsOn.filter((d): d is string => typeof d === 'string') }
            : {}),
          ...(Array.isArray(itemRow.executionSteps)
            ? {
                executionSteps: itemRow.executionSteps.filter(
                  (d): d is string => typeof d === 'string'
                ),
              }
            : {}),
        };
      }),
    },
    repositories,
    stage: stage as ExecutionStage,
    verification: {
      steps: arr(verificationRow.steps ?? [], 'assignment.verification.steps').map((s, i) =>
        parseVerificationStep(s, i, seen)
      ),
      ...(verificationRow.allowDiscovery === true ? { allowDiscovery: true } : {}),
    },
    leaseExpiresAt: str(row, 'leaseExpiresAt', 'assignment'),
  };
}

/**
 * Work items in an order that respects dependsOn.
 *
 * Returns null when the graph cannot be satisfied — a cycle, or a dependency
 * on something not in the snapshot. That is a question for Feature1 rather
 * than something to guess an order around.
 */
export function orderedItems(assignment: Assignment): Assignment['requirements']['items'] | null {
  const items = assignment.requirements.items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const done = new Set<string>();
  const out: typeof items = [];
  let progress = true;
  while (out.length < items.length && progress) {
    progress = false;
    for (const item of items) {
      if (done.has(item.id)) continue;
      const deps = item.dependsOn ?? [];
      if (deps.some((d) => !byId.has(d))) return null;
      if (deps.every((d) => done.has(d))) {
        out.push(item);
        done.add(item.id);
        progress = true;
      }
    }
  }
  return out.length === items.length ? out : null;
}

/**
 * Deterministic idempotency keys.
 *
 * A retried send must be recognisable as the same event, including after the
 * worker has restarted — so the key is derived from identity the worker will
 * still have, never from a clock or a random value.
 */
export function idempotencyKey(parts: {
  executionId: string;
  attemptId: string;
  kind: string;
  discriminator?: string;
}): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._:-]+/g, '_');
  return [
    safe(parts.executionId),
    safe(parts.attemptId),
    safe(parts.kind),
    ...(parts.discriminator ? [safe(parts.discriminator)] : []),
  ].join(':');
}

/** The repository, or a refusal naming it. Scope is checked, never assumed. */
export function authorisedRepository(assignment: Assignment, repositoryId: string): RepositoryRef {
  const repo = assignment.repositories.find((r) => r.repositoryId === repositoryId);
  if (!repo) {
    throw new Error(
      `Repository ${repositoryId} is not authorised by assignment ${assignment.assignmentId}`
    );
  }
  return repo;
}
