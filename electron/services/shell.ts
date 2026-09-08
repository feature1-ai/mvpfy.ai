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
 * Stop a spawned command and everything it started.
 *
 * Every command runs through a shell, so the process we hold is cmd.exe or
 * zsh — docker, claude and git are its children. On POSIX a signal to the
 * process group reaches them. On Windows there are no process groups and
 * child.kill() maps to TerminateProcess on the shell alone, so the real work
 * carries on with nobody watching it: taskkill /T walks the tree instead.
 */
export function killProcessTree(child: ChildProcess | undefined): void {
  const pid = child?.pid;
  if (!child || !pid) return;
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000 });
    } catch {
      // Fall through: better a stray process than a crash on quit.
    }
    return;
  }
  child.kill('SIGTERM');
}

/** `%VAR%` references, as stored in the registry's REG_EXPAND_SZ PATH. */
function expandWinVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

/**
 * Directories out of `reg query ... /v Path` output, which looks like:
 *
 *     HKEY_CURRENT_USER\Environment
 *         Path    REG_EXPAND_SZ    C:\Users\me\.local\bin;%APPDATA%\npm
 *
 * PATHEXT cannot be mistaken for Path: the name must be followed by space.
 */
export function parseRegistryPath(stdout: string): string[] {
  const match = stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im);
  if (!match) return [];
  return expandWinVars(match[1].trim())
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** PATH as the registry records it — the value a new process would inherit. */
function registryPath(): string[] {
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ];
  const out: string[] = [];
  for (const key of keys) {
    try {
      const res = spawnSync('reg', ['query', key, '/v', 'Path'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (res.status === 0) out.push(...parseRegistryPath(res.stdout));
    } catch {
      // No reg.exe, or a locked-down machine: fall back to the inherited PATH.
    }
  }
  return out;
}

/**
 * Windows hands a running app the environment it started with, and editing
 * PATH in System Properties does not reach one — nor, usually, anything else
 * launched from the Explorer session that was already open, until the user
 * signs out. So read PATH from the registry, where the edit actually landed,
 * and add the places our CLIs install themselves even when PATH was never
 * updated at all.
 */
export function resolveWindowsPath(): void {
  const home = process.env.USERPROFILE || os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const extras = [
    path.join(home, '.local', 'bin'), // claude, the native installer
    path.join(appData, 'npm'), // codex and anything else installed by npm -g
    path.join(localAppData, 'Programs', 'Git', 'cmd'),
    path.join(programFiles, 'Git', 'cmd'),
    path.join(programFiles, 'GitHub CLI'),
    path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin'),
  ];
  const merged = new Set(
    [...(process.env.PATH || '').split(';'), ...registryPath(), ...extras]
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  process.env.PATH = [...merged].join(';');
}

/**
 * Finder-launched apps get a minimal PATH, and `zsh -lc` only sources
 * ~/.zprofile — while nvm/npm tools usually configure PATH in ~/.zshrc
 * (interactive-only). Resolve the user's real PATH once via an interactive
 * login shell and adopt it, so claude/codex/gh installed any way are found.
 */
export function resolveUserPath(): void {
  if (IS_WIN) {
    resolveWindowsPath();
    return;
  }
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
