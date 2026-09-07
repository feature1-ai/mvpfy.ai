import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

// GUI apps on macOS get a minimal PATH; run commands through the user's login
// shell so tools installed via Homebrew/nvm/etc. are found. On Windows we go
// through cmd.exe instead.
export const IS_WIN = process.platform === 'win32';
export const USER_SHELL =
  process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

/**
 * cmd.exe arguments for a command that is ALREADY quoted for the shell.
 *
 * Node escapes each argument using Windows CRT rules before building the
 * command line, which rewrites our inner quotes as \" — a form cmd.exe does
 * not understand and passes through literally, so the child ends up with real
 * quote characters inside its arguments (a clone destination like "C:\...\repo"
 * is then an invalid Windows filename). Callers must therefore pair this with
 * windowsVerbatimArguments so the string survives untouched; the outer quotes
 * added here are the ones `/s` strips back off before running the command.
 */
export function winShellArgs(command: string): string[] {
  return ['/d', '/s', '/c', `"${command}"`];
}

const WIN_SHELL = () => process.env.ComSpec || 'cmd.exe';

export function spawnShell(command: string, opts: Parameters<typeof spawn>[2]): ChildProcess {
  return IS_WIN
    ? spawn(WIN_SHELL(), winShellArgs(command), { ...opts, windowsVerbatimArguments: true })
    : spawn(USER_SHELL, ['-lc', command], opts);
}

export function spawnShellSync(
  command: string,
  opts: { encoding: 'utf8'; timeout: number; env?: NodeJS.ProcessEnv }
) {
  return IS_WIN
    ? spawnSync(WIN_SHELL(), winShellArgs(command), { ...opts, windowsVerbatimArguments: true })
    : spawnSync(USER_SHELL, ['-lc', command], opts);
}

/**
 * `cd` into a directory as part of a shell command. cmd.exe will not follow a
 * path onto a different drive without /d — it changes the directory on that
 * drive and carries on running where it was, so the command silently executes
 * against the wrong folder rather than failing.
 */
export function cdTo(dir: string): string {
  return IS_WIN ? `cd /d ${shellQuote(dir)}` : `cd ${shellQuote(dir)}`;
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
