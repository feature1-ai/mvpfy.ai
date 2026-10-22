import * as path from 'node:path';
import { validUuid } from '../shared/runner/validate';

/**
 * Where a worker keeps things on disk.
 *
 * Keyed by stable ids the whole way down — tenant, execution, repository —
 * and never by a repository's name, because an assignment may well hold two
 * repositories both called `api`. Keying by basename would put them in the
 * same directory, and the second clone would quietly become the first.
 *
 *   <root>/clones/<tenantId>/<repositoryId>.git     bare, shared by executions
 *   <root>/executions/<tenantId>/<executionId>/
 *       execution.json                              the checkpoint
 *       repos/<repositoryId>/                       the worktree
 *       agent/                                      prompts and run logs
 *
 * The clone is separate from the worktree on purpose: an execution's
 * checkouts share one object store, so a second execution in the same
 * repository costs a worktree rather than a download, and a restart does not
 * re-clone what is already here.
 */
export class Layout {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('The worker root must be an absolute path');
  }

  private static check(kind: string, value: string): string {
    // These become directory names. Feature1 keys everything by UUID, so a
    // UUID is what a path segment must be — refused rather than sanitised,
    // because sanitising two different ids to one name is how an execution
    // writes into another's directory.
    if (!validUuid(value)) throw new Error(`${kind} is not a UUID: ${value}`);
    return value;
  }

  /** The bare clone every execution in this tenant shares. */
  cloneDir(tenantId: string, repositoryId: string): string {
    return path.join(
      this.root,
      'clones',
      Layout.check('tenantId', tenantId),
      `${Layout.check('repositoryId', repositoryId)}.git`
    );
  }

  executionDir(tenantId: string, executionId: string): string {
    return path.join(
      this.root,
      'executions',
      Layout.check('tenantId', tenantId),
      Layout.check('executionId', executionId)
    );
  }

  checkpointFile(tenantId: string, executionId: string): string {
    return path.join(this.executionDir(tenantId, executionId), 'execution.json');
  }

  /** The checkout this execution works in, for one repository. */
  worktreeDir(tenantId: string, executionId: string, repositoryId: string): string {
    return path.join(
      this.executionDir(tenantId, executionId),
      'repos',
      Layout.check('repositoryId', repositoryId)
    );
  }

  agentDir(tenantId: string, executionId: string): string {
    return path.join(this.executionDir(tenantId, executionId), 'agent');
  }

  /** Where executions live, for the recovery sweep on start-up. */
  executionsRoot(): string {
    return path.join(this.root, 'executions');
  }

  /**
   * True when a path is inside this worker's root.
   *
   * Asserted before anything is removed. Every path above is safe by
   * construction, and this is the check that keeps it true after somebody
   * adds a path that is not.
   */
  contains(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    const root = path.resolve(this.root);
    return resolved === root || resolved.startsWith(root + path.sep);
  }
}

/** The branch an execution works on. Stable, so a revision reuses it. */
export function executionBranch(executionId: string): string {
  return `mvpfy/${executionId}`;
}
