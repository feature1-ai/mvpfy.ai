import * as path from 'node:path';
import { ExecutionRepository } from '../shared/runner/contract';
import { Git } from './git';

/**
 * A product's repositories, checked out together the way the desktop app's
 * workspace keeps them: one folder per repository, side by side, under one
 * root that setup and a test link both treat as the product.
 *
 * A product of one repository keeps that repository as its root, as it
 * always has, so a recipe made before several were possible still fits.
 */

/** A folder name per repository: its name, made unique where two share one. */
export function repositoryFolders(repos: ExecutionRepository[]): Map<string, string> {
  const folders = new Map<string, string>();
  const taken = new Set<string>();
  for (const repo of repos) {
    const base = repo.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'repository';
    const name = taken.has(base) ? `${base}-${repo.id.slice(0, 8)}` : base;
    taken.add(name);
    folders.set(repo.id, name);
  }
  return folders;
}

/** Where the product's root is, under `base`. */
export function workspaceDir(base: string, repos: ExecutionRepository[]): string {
  const [only] = repos;
  return repos.length === 1 && only ? path.join(base, only.id) : path.join(base, 'workspace');
}

/** What each repository was checked out at, by folder. */
export interface WorkspaceCheckout {
  dir: string;
  commits: Record<string, { branch: string; commit: string }>;
}

/**
 * Check every repository out under `base`, each at the branch `branchFor`
 * picks, and say what each ended up at.
 */
export async function checkOutWorkspace(
  git: Pick<Git, 'detachedCheckout'>,
  tenantId: string,
  repos: ExecutionRepository[],
  base: string,
  branchFor: (repo: ExecutionRepository) => Promise<string> | string
): Promise<WorkspaceCheckout> {
  const dir = workspaceDir(base, repos);
  const folders = repositoryFolders(repos);
  const commits: WorkspaceCheckout['commits'] = {};
  for (const repo of repos) {
    const folder = folders.get(repo.id) ?? repo.id;
    const target = repos.length === 1 ? dir : path.join(dir, folder);
    const branch = await branchFor(repo);
    commits[folder] = {
      branch,
      commit: await git.detachedCheckout(tenantId, repo, branch, target),
    };
  }
  return { dir, commits };
}
