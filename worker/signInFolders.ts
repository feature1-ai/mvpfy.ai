import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where the sign-ins are kept, made sure of before anything looks there.
 *
 * The worker image points `gh`, Claude Code and Codex at folders on the
 * worker's volume so a replaced container is still signed in. A new volume is
 * empty, and Codex will not start at all when the folder it is pointed at is
 * missing — not even to sign in. So the folders are made here, by the worker,
 * rather than in the image, where a mounted volume would hide them.
 *
 * Only variables that are set are acted on: somebody running the worker by
 * hand with none of them set keeps each tool's own default.
 */

const SIGN_IN_FOLDERS = ['GH_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

/** Resolves with the folders that now exist. Private to this user: they hold tokens. */
export function ensureSignInFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const made: string[] = [];
  for (const name of SIGN_IN_FOLDERS) {
    const folder = (env[name] ?? '').trim();
    if (!folder || !path.isAbsolute(folder)) continue;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    made.push(folder);
  }
  return made;
}
