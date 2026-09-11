import * as fs from 'node:fs';
import * as path from 'node:path';
import { ComposeAction, ServiceState } from '../../shared/types';
import { IS_WIN, shellQuote, spawnShellSync } from './shell';

/** Docker specifics: local-context pinning, daemon checks, command builders. */

// Users often have `docker context use` pointing at a remote engine (ssh://…).
// mvpfy must never deploy there: pin every spawned command to a local engine.
let cachedLocalDockerContext: string | null | undefined;

export function localDockerContext(): string | null {
  if (cachedLocalDockerContext !== undefined) return cachedLocalDockerContext;
  const result = spawnShellSync('docker context ls --format "{{.Name}}"', {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const names =
    result.status === 0
      ? result.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  cachedLocalDockerContext = names.includes('desktop-linux')
    ? 'desktop-linux'
    : names.includes('default')
      ? 'default'
      : null;
  return cachedLocalDockerContext;
}

export function spawnEnv(): NodeJS.ProcessEnv {
  const ctx = localDockerContext();
  return ctx ? { ...process.env, DOCKER_CONTEXT: ctx } : { ...process.env };
}

// If the local daemon is down, launch Docker Desktop and wait for it
// (PMs won't know the whale needs to be running first). Only macOS can
// reliably auto-start Docker Desktop; elsewhere we fail with a clear message.
export const ENSURE_DAEMON = IS_WIN
  ? 'docker info >NUL 2>&1 || (echo Docker is not running — start Docker Desktop and retry. && exit /b 1)'
  : process.platform === 'darwin'
    ? 'docker info >/dev/null 2>&1 || { echo "Docker is not running — starting Docker Desktop…"; ' +
      'open -a Docker >/dev/null 2>&1; ' +
      'for i in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 2; done; }'
    : 'docker info >/dev/null 2>&1 || { echo "Docker daemon is not running — start it (e.g. systemctl start docker) and retry."; exit 1; }';

export function ideContainerName(workspacePath: string): string {
  const base = path
    .basename(workspacePath)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  return `mvpfy-ide-${base}`;
}

/**
 * Live status of a project's IDE container, straight from docker — the
 * stored idePort can go stale (reboots kill containers; another project's
 * code-server may later bind the same port, which would embed the WRONG
 * project's editor if trusted).
 */
export function ideStatus(workspacePath: string): { running: boolean; port: number | null } {
  const name = ideContainerName(workspacePath);
  const result = spawnShellSync(
    `docker ps --filter ${shellQuote(`name=^${name}$`)} --format "{{.Ports}}"`,
    { encoding: 'utf8', timeout: 10_000, env: spawnEnv() }
  );
  if (result.status !== 0) return { running: false, port: null };
  const line = (result.stdout ?? '').trim().split('\n')[0] ?? '';
  if (!line) return { running: false, port: null };
  const m = line.match(/:(\d+)->8080\/tcp/);
  return { running: true, port: m ? Number(m[1]) : null };
}

/**
 * Parse `docker compose ps --format json`, which is a JSON array in some
 * versions of compose and one object per line in others. Anything it cannot
 * read yields nothing, and the caller falls back to saying less.
 */
export function parseComposePs(stdout: string): ServiceState[] {
  const text = (stdout ?? '').trim();
  if (!text) return [];
  const rows: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) rows.push(...parsed);
    else rows.push(parsed);
  } catch {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // A partial line; the rest of the output is still usable.
      }
    }
  }
  return rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .map((r) => ({
      service: String(r.Service ?? r.Name ?? '').trim(),
      state: String(r.State ?? '')
        .trim()
        .toLowerCase(),
      exitCode: Number.isFinite(Number(r.ExitCode)) ? Number(r.ExitCode) : null,
    }))
    .filter((r) => r.service);
}

/**
 * What the stack is actually doing.
 *
 * `docker compose up -d` reports success once containers have STARTED, so a
 * container that starts and immediately dies still exits zero. Asking docker
 * afterwards is the only way to tell an app that is still booting from one
 * that is never coming.
 */
export function composeStatus(workspacePath: string, linked: boolean): ServiceState[] {
  const base = linked
    ? 'docker compose -f .mvpfy/docker-compose.mvpfy.yml --project-directory .'
    : 'docker compose -f docker-compose.mvpfy.yml';
  // cwd rather than chdir: the compose file path is relative, and changing the
  // main process's own directory would race every other command it runs.
  const result = spawnShellSync(`${base} ps -a --format json`, {
    encoding: 'utf8',
    timeout: 15_000,
    env: spawnEnv(),
    cwd: workspacePath,
  });
  if (result.status !== 0) return [];
  return parseComposePs(result.stdout ?? '');
}

/**
 * The one line mvpfy runs to seed a project, as recorded in its mvpfy.yml.
 *
 * Read here rather than passed in: the renderer says "seed this workspace" and
 * the command comes from the file on disk, the same way every other command is
 * built in the main process rather than handed to it.
 *
 * Null when the key is absent — a product that needs no seeding is normal, not
 * a failure.
 */
export function seedCommandFor(workspacePath: string, linked: boolean): string | null {
  const file = path.join(workspacePath, linked ? '.mvpfy' : '', 'mvpfy.yml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(/^\s*seed_command:\s*(?:["']([^"']+)["']|([^\n#]+))/m);
  const command = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!command) return null;
  // Newlines would turn one recorded line into several commands; a recorded
  // seed is one line by contract, so anything else is not it.
  return command.includes('\n') ? null : command;
}

export function composeCommand(action: ComposeAction, linked = false): string {
  // Linked repos keep the compose file inside .mvpfy/; --project-directory
  // pins relative build contexts and volume paths to the workspace root so
  // the file's content works identically in both modes.
  const base = linked
    ? 'docker compose -f .mvpfy/docker-compose.mvpfy.yml --project-directory .'
    : 'docker compose -f docker-compose.mvpfy.yml';
  // Follow-mode container logs: no daemon auto-start (fails fast when down).
  if (action === 'logs') {
    return `${base} logs -f --tail=200`;
  }
  // --remove-orphans: compose only manages the services named in the file it
  // is given, and bootstrap rewrites that file. A service the agent renames or
  // drops between runs is left running forever — still holding its port, so
  // the next `up` cannot bind it. Never --volumes here: Stop must not delete
  // the database. That belongs to deleting the project, and lives there.
  const up = `${base} up -d --build --remove-orphans`;
  const down = `${base} down --remove-orphans`;
  // Force stop: SIGKILL now rather than the polite SIGTERM-then-wait, for a
  // container that ignores the signal or takes minutes to drain. `kill` exits
  // non-zero when nothing is running, so the teardown must follow regardless
  // of its result — that is `;` in a shell and `&` in cmd.
  const alsoRun = IS_WIN ? '&' : ';';
  const forceDown = `${base} kill ${alsoRun} ${down}`;
  const compose =
    action === 'up'
      ? up
      : action === 'down'
        ? down
        : action === 'force-down'
          ? forceDown
          : `${down} && ${up}`;
  return `${ENSURE_DAEMON} && ${compose}`;
}

export function ideCommand(workspacePath: string, action: 'up' | 'down', port?: number): string {
  const name = ideContainerName(workspacePath);
  if (action === 'down') return `${ENSURE_DAEMON} && docker rm -f ${name}`;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65000) {
    throw new Error('A valid port is required to start the IDE');
  }
  // Clear any container left from a previous run, ignoring "no such container",
  // then start regardless of that outcome — `&` is cmd's unconditional
  // separator, the counterpart of the shell's `;`.
  const quietlyThenContinue = IS_WIN ? '>NUL 2>&1 &' : '>/dev/null 2>&1;';
  return (
    `${ENSURE_DAEMON} && docker rm -f ${name} ${quietlyThenContinue} ` +
    `docker run -d --name ${name} -p ${port}:8080 ` +
    `-v ${shellQuote(workspacePath)}:/home/coder/project ` +
    `codercom/code-server:latest --auth none --bind-addr 0.0.0.0:8080 /home/coder/project`
  );
}
