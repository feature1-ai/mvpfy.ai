import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

// GUI apps on macOS get a minimal PATH; run commands through the user's login
// shell so tools installed via Homebrew/nvm/etc. are found. On Windows we go
// through cmd.exe instead.
export const IS_WIN = process.platform === 'win32';
export const USER_SHELL =
  process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

export function spawnShell(command: string, opts: Parameters<typeof spawn>[2]): ChildProcess {
  return IS_WIN
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], opts)
    : spawn(USER_SHELL, ['-lc', command], opts);
}

export function spawnShellSync(
  command: string,
  opts: { encoding: 'utf8'; timeout: number; env?: NodeJS.ProcessEnv }
) {
  return IS_WIN
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], opts)
    : spawnSync(USER_SHELL, ['-lc', command], opts);
}

export function shellQuote(value: string): string {
  if (IS_WIN) return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Finder-launched apps get a minimal PATH, and `zsh -lc` only sources
 * ~/.zprofile — while nvm/npm tools usually configure PATH in ~/.zshrc
 * (interactive-only). Resolve the user's real PATH once via an interactive
 * login shell and adopt it, so claude/codex/gh installed any way are found.
 */
export function resolveUserPath(): void {
  if (IS_WIN) return;
  try {
    const result = spawnSync(USER_SHELL, ['-ilc', 'printf "__MVPFY_PATH__%s" "$PATH"'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const match = result.stdout?.match(/__MVPFY_PATH__([^\n]*)/);
    const shellPath = match?.[1] ?? '';
    const extras = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), 'bin'),
    ];
    const merged = new Set(
      [...shellPath.split(':'), ...(process.env.PATH || '').split(':'), ...extras].filter(Boolean)
    );
    process.env.PATH = [...merged].join(':');
  } catch {
    // Keep the inherited PATH; the Settings checklist will surface gaps.
  }
}
