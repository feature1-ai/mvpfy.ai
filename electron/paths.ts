import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const MVPFY_HOME = path.join(os.homedir(), '.mvpfy');
export const PROJECTS_DIR = path.join(MVPFY_HOME, 'projects');
export const TMP_DIR = path.join(MVPFY_HOME, 'tmp');
export const STATE_FILE = path.join(MVPFY_HOME, 'state.json');
export const SECRETS_FILE = path.join(MVPFY_HOME, 'secrets.json');

export function ensureDirs(): void {
  for (const dir of [MVPFY_HOME, PROJECTS_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** True when `candidate` is inside the managed projects directory. */
export function isManagedPath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved !== PROJECTS_DIR && resolved.startsWith(PROJECTS_DIR + path.sep);
}

// Linked (in-place) projects live outside ~/.mvpfy/projects at paths the user
// explicitly chose. The registry mirrors state.json and is refreshed on every
// state read/write, so path guards can allow exactly those roots and no more.
let linkedRoots: string[] = [];

export function setLinkedRoots(roots: string[]): void {
  linkedRoots = roots.map((r) => path.resolve(r));
}

export function isLinkedPath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return linkedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** Managed clone or an explicitly linked in-place workspace. */
export function isAllowedWorkspace(candidate: string): boolean {
  return isManagedPath(candidate) || isLinkedPath(candidate);
}
