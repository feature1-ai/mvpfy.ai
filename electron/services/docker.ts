import * as path from 'node:path';
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

export function composeCommand(action: 'up' | 'down' | 'restart'): string {
  const up = 'docker compose -f docker-compose.mvpfy.yml up -d --build';
  const down = 'docker compose -f docker-compose.mvpfy.yml down';
  const compose = action === 'up' ? up : action === 'down' ? down : `${down} && ${up}`;
  return `${ENSURE_DAEMON} && ${compose}`;
}

export function ideCommand(workspacePath: string, action: 'up' | 'down', port?: number): string {
  const name = ideContainerName(workspacePath);
  if (action === 'down') return `${ENSURE_DAEMON} && docker rm -f ${name}`;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65000) {
    throw new Error('A valid port is required to start the IDE');
  }
  return (
    `${ENSURE_DAEMON} && docker rm -f ${name} >/dev/null 2>&1; ` +
    `docker run -d --name ${name} -p ${port}:8080 ` +
    `-v ${shellQuote(workspacePath)}:/home/coder/project ` +
    `codercom/code-server:latest --auth none --bind-addr 0.0.0.0:8080 /home/coder/project`
  );
}
