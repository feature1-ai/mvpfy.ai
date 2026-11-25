import { spawnEnv } from './docker';
import { readRepoFiles } from './repoFiles';
import { spawnShellAsync } from './shell';
import type { CheckAccess } from '../../shared/unitChecks';

// The checks themselves are in shared/, so the headless worker makes the same
// ones. What stays here is how the desktop reaches a workspace.
export { failedChecks } from '../../shared/unitChecks';
export type { CheckAccess } from '../../shared/unitChecks';

/** The real thing: the workspace on disk, held to the same guard as every other read. */
export function workspaceAccess(repoPath: string): CheckAccess {
  return {
    read: (relativePath) => {
      const [file] = readRepoFiles(repoPath, [relativePath]);
      return file?.exists ? (file.content ?? '') : null;
    },
    run: (command) => spawnShellAsync(command, { cwd: repoPath, env: spawnEnv(), timeout: 60_000 }),
  };
}
