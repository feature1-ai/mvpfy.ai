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
