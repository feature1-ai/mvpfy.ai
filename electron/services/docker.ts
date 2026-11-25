import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ComposeAction, ComposeProgress, ServiceState } from '../../shared/types';
import { IS_WIN, shellQuote, spawnShellAsync, spawnShellSync } from './shell';

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
  cachedLocalDockerContext = pickLocalContext(result.status === 0 ? result.stdout : '');
  return cachedLocalDockerContext;
}

/**
 * `docker compose` pointed at the file mvpfy generated: beside the code for a
 * managed clone, inside `.mvpfy/` for a linked folder (whose root it must not
 * litter), with the project directory kept at the repo root either way.
 */
import { composeBase } from '../../shared/compose';

export { composeBase };

/**
 * Resolves the Docker context ahead of the first command that needs it, so
 * localDockerContext's spawnSync never runs inside an IPC call: started at
 * launch, off the main thread, beside the user environment.
 */
export async function primeLocalDockerContext(): Promise<void> {
  if (cachedLocalDockerContext !== undefined) return;
  const result = await spawnShellAsync('docker context ls --format "{{.Name}}"', {
    timeout: 10_000,
  });
  if (cachedLocalDockerContext !== undefined) return;
  cachedLocalDockerContext = pickLocalContext(result.status === 0 ? result.stdout : '');
}

function pickLocalContext(stdout: string): string | null {
  const names = stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.includes('desktop-linux')
    ? 'desktop-linux'
    : names.includes('default')
      ? 'default'
      : null;
}

export function spawnEnv(): NodeJS.ProcessEnv {
  const ctx = localDockerContext();
  // BuildKit, explicitly, because the default depends on the engine's age and
  // this one is old on plenty of laptops. It is worth asking for by name: it
  // hashes the build context instead of shipping it whole, skips stages
  // nothing depends on, builds independent stages at the same time, and is
  // the only builder that honours `RUN --mount=type=cache`, which is what
  // keeps a one-package change from reinstalling every dependency.
  return {
    ...process.env,
    ...(ctx ? { DOCKER_CONTEXT: ctx } : {}),
    DOCKER_BUILDKIT: '1',
    COMPOSE_DOCKER_CLI_BUILD: '1',
  };
}

/**
 * What a build context must never carry.
 *
 * Without a .dockerignore, `docker build` tars the whole directory and sends
 * it to the daemon before it reads the first line of the Dockerfile — and on
 * a brownfield checkout almost all of that is the one thing the image is
 * about to install for itself. Measured on mvpfy's own repository: 2.6 MB of
 * tracked source under 406 MB of node_modules, so 157 times the payload for
 * no effect on the image. mvpfy passes --build on every start, and on macOS
 * that tar crosses the file-sharing boundary each time.
 *
 * Only directories a dev-mode image rebuilds from scratch anyway. Nothing
 * here can change what lands in the image: the generated Dockerfile installs
 * dependencies itself (the watcher rule requires the full tree in the image),
 * and the source is bind-mounted over at run time regardless.
 */
const DOCKERIGNORE_LINES = [
  '# Written by mvpfy because this build context had no .dockerignore.',
  '# Everything here is reinstalled or rebuilt inside the image, so sending it',
  '# only makes the build slower. Safe to edit; mvpfy will not rewrite it.',
  '.git',
  '.gitignore',
  'node_modules',
  '**/node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '**/__pycache__',
  '*.pyc',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  'vendor/bundle',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '*.log',
  '.DS_Store',
  // mvpfy's own scaffolding: the live .env in particular, which holds the
  // local defaults and has no business baked into an image layer.
  '.env',
  '.mvpfy',
  'mvpfy-*.md',
  'mvpfy-*.json',
];

/**
 * Give every build context a .dockerignore, but never replace one.
 *
 * Absent means the team never had one, so there is no behaviour to preserve —
 * their own `docker build` was already shipping the whole checkout. Present
 * means somebody made a decision, and a generated file is not better informed
 * than they were.
 *
 * Returns the paths written, for the caller to report.
 */
export function ensureDockerignore(workspacePath: string): string[] {
  const root = path.resolve(workspacePath);
  const written: string[] = [];
  // The root, plus one level down: mvpfy's layouts are a single repository at
  // the workspace root, or one folder per repository inside it. A build
  // context deeper than that belongs to a generated mock, which is small.
  const candidates = [root];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No such workspace, or no permission to list it. Nothing to write.
    return written;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    candidates.push(path.join(root, entry.name));
  }
  for (const dir of candidates) {
    const ignore = path.join(dir, '.dockerignore');
    // Only where something is actually built, so this never litters a folder
    // that is not a build context.
    const builds = ['Dockerfile', 'Dockerfile.mvpfy'].some((name) =>
      fs.existsSync(path.join(dir, name))
    );
    if (!builds || fs.existsSync(ignore)) continue;
    try {
      fs.writeFileSync(ignore, `${DOCKERIGNORE_LINES.join('\n')}\n`, 'utf8');
      written.push(ignore);
    } catch {
      // A read-only checkout is not a reason to fail the start.
    }
  }
  return written;
}

// If the local daemon is down, launch Docker Desktop and wait for it
// (PMs won't know the whale needs to be running first). Only macOS can
// reliably auto-start Docker Desktop; elsewhere we fail with a clear message.
//
// Parenthesised on Windows, and that is not style. cmd.exe gives `||` lower
// precedence than `&&`, so `docker info || (…) && docker compose up` parses as
// `docker info || ((…) && docker compose up)`: with Docker running, the
// command every caller appends was skipped, silently, with exit code 0 —
// starting the app, restarting it, the editor and seeding all did nothing.
export const ENSURE_DAEMON = IS_WIN
  ? '(docker info >NUL 2>&1 || (echo Docker is not running — start Docker Desktop and retry. && exit /b 1))'
  : process.platform === 'darwin'
    ? 'docker info >/dev/null 2>&1 || { echo "Docker is not running — starting Docker Desktop…"; ' +
      'open -a Docker >/dev/null 2>&1; ' +
      'for i in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 2; done; }'
    : 'docker info >/dev/null 2>&1 || { echo "Docker daemon is not running — start it (e.g. systemctl start docker) and retry."; exit 1; }';

/**
 * Docker Desktop's own settings, as they affect a bind-mount-heavy stack.
 *
 * mvpfy runs every app in development mode with the repository bind-mounted
 * and a file watcher on it, so host file access is not a detail of the setup —
 * it IS the setup. Docker Desktop's oldest file sharing (osxfs, then
 * gRPC-FUSE) pays a syscall-per-operation round trip to the host; Apple's
 * Virtualization framework with VirtioFS does not. Measured on one laptop
 * with both switched off: 2000 small files took 5.27 s on a bind mount
 * against 0.42 s on a volume inside the VM, and reading them back 6.09 s
 * against 1.26 s. A dependency install, a bundler's first pass and a watcher's
 * initial scan are all exactly that shape of work.
 *
 * Worth surfacing rather than fixing: these live in Docker Desktop's own
 * preferences, and mvpfy has no business writing another application's
 * settings file underneath the person using it.
 *
 * Pure, so the awkward part — a settings file whose shape changed across
 * versions — is testable without a Docker install.
 */
export function fileSharingAdvice(settings: Record<string, unknown>): string[] {
  const advice: string[] = [];
  // Absent is not false: an old settings file simply has no such key, and
  // claiming the fast path is off because a key is missing would be a guess.
  // Only an explicit false is a finding.
  const vz = settings.useVirtualizationFramework;
  const virtiofs = settings.useVirtualizationFrameworkVirtioFS;
  if (vz === false) {
    advice.push(
      "Docker Desktop is using the legacy virtual machine, not Apple's Virtualization " +
        'framework. Settings → General → "Use Virtualization framework" turns it on, and is ' +
        'the switch the next one depends on.'
    );
  }
  if (virtiofs === false) {
    advice.push(
      'File sharing is not using VirtioFS, which is the slow part of running your code from ' +
        'a bind mount. Settings → General → "VirtioFS" (it needs the Virtualization framework ' +
        "above). Expect file-heavy work — installs, first page load, the watcher's first scan " +
        '— to be several times faster.'
    );
  }
  const memory = Number(settings.memoryMiB);
  if (Number.isFinite(memory) && memory > 0 && memory < 6144) {
    advice.push(
      `Docker Desktop has ${Math.round(memory / 1024)} GB of memory. A product with a ` +
        'database, a cache and two apps will swap inside the VM at that size; 8 GB is a ' +
        'reasonable floor (Settings → Resources).'
    );
  }
  return advice;
}

/**
 * Read those settings off disk. Null when there is nothing to read — not
 * installed, a different platform, a shape this does not recognise — which is
 * different from "read it and found nothing wrong".
 */
export function dockerDesktopSettings(): Record<string, unknown> | null {
  if (process.platform !== 'darwin') return null;
  const home = process.env.HOME;
  if (!home) return null;
  const candidates = [
    path.join(home, 'Library', 'Group Containers', 'group.com.docker', 'settings-store.json'),
    path.join(home, 'Library', 'Group Containers', 'group.com.docker', 'settings.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // The next candidate, or none.
    }
  }
  return null;
}

export function ideContainerName(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const base = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  // The folder name alone collided: ~/a/app and ~/b/app were both
  // mvpfy-ide-app, so starting one editor removed the other's, and the status
  // check reported the wrong project's. A short hash of the full path keeps
  // the readable name and makes it this folder's alone.
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `mvpfy-ide-${base}-${hash}`;
}

/**
 * The name earlier versions gave the editor's container. Cleared alongside the
 * current one, so an editor started before the upgrade is not left running —
 * holding its port, serving its folder — with nothing that knows its name.
 */
export function legacyIdeContainerName(workspacePath: string): string {
  return `mvpfy-ide-${path
    .basename(path.resolve(workspacePath))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')}`;
}

/**
 * Live status of a project's IDE container, straight from docker — the
 * stored idePort can go stale (reboots kill containers; another project's
 * code-server may later bind the same port, which would embed the WRONG
 * project's editor if trusted).
 */
export async function ideStatus(
  workspacePath: string
): Promise<{ running: boolean; port: number | null }> {
  const name = ideContainerName(workspacePath);
  const result = await spawnShellAsync(
    `docker ps --filter ${shellQuote(`name=^${name}$`)} --format "{{.Ports}}"`,
    { timeout: 10_000, env: spawnEnv() }
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
      health: String(r.Health ?? '')
        .trim()
        .toLowerCase(),
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
export async function composeStatus(
  workspacePath: string,
  linked: boolean
): Promise<ServiceState[]> {
  const base = composeBase(linked);
  // cwd rather than chdir: the compose file path is relative, and changing the
  // main process's own directory would race every other command it runs.
  const result = await spawnShellAsync(`${base} ps -a --format json`, {
    timeout: 15_000,
    env: spawnEnv(),
    cwd: workspacePath,
  });
  if (result.status !== 0) return [];
  return parseComposePs(result.stdout ?? '');
}

/**
 * The environment a running container was actually given.
 *
 * The question the env editor could not answer. Saving a variable writes it
 * to a file; whether the app ever sees it is a different matter, and the
 * three ways it does not are all silent — the container has not been
 * recreated since, the variable is in a file this service does not read, or
 * the app baked its value in at build time. Every one of those looks
 * identical from the outside: the editor says saved, the file has it, and
 * the app behaves as though it was never set.
 *
 * Read from `docker inspect` rather than `exec env`: it needs no process in
 * the container, works on an image with no shell, and reports what the
 * container was created with — which is precisely what "picked up" means.
 */
export function parseInspectEnv(json: string): Record<string, string> {
  let rows: unknown;
  try {
    rows = JSON.parse(json.trim() || 'null');
  } catch {
    return {};
  }
  if (!Array.isArray(rows)) return {};
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row !== 'string') continue;
    const at = row.indexOf('=');
    if (at <= 0) continue;
    out[row.slice(0, at)] = row.slice(at + 1);
  }
  return out;
}

/**
 * Null when it could not be read — no such service, nothing running, docker
 * not answering. Null and empty are different answers and the interface says
 * different things about them: one is "we do not know", the other is "this
 * container has no variables at all".
 */
export async function runningEnv(
  workspacePath: string,
  linked: boolean,
  service: string
): Promise<Record<string, string> | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(service.trim())) return null;
  const base = composeBase(linked);
  const opts = {
    timeout: 15_000,
    env: spawnEnv(),
    cwd: workspacePath,
  };
  const ids = await spawnShellAsync(`${base} ps -q ${shellQuote(service.trim())}`, opts);
  if (ids.status !== 0) return null;
  // The first line: a service scaled past one is not something mvpfy
  // generates, and the first container is the honest answer for the rest.
  const id = (ids.stdout ?? '').trim().split('\n')[0]?.trim();
  if (!id) return null;
  const inspected = await spawnShellAsync(
    `docker inspect --format ${shellQuote('{{json .Config.Env}}')} ${shellQuote(id)}`,
    opts
  );
  if (inspected.status !== 0) return null;
  return parseInspectEnv(inspected.stdout ?? '');
}

/**
 * What the stack is doing, and whether it is still doing anything.
 *
 * The second half is the point. Deciding an app has failed by counting seconds
 * asks the wrong question — the answer depends on the machine, the size of the
 * image and whether a build is cached — and a laptop that is merely slow gets
 * called broken. A booting app writes: migrations, compiling, listening on.
 * A stuck one writes nothing. So the tail of the logs is sampled, and while it
 * keeps changing there is nothing to decide.
 *
 * Only the tail, so the cost does not grow with the log.
 */
export async function composeProgress(
  workspacePath: string,
  linked: boolean
): Promise<ComposeProgress> {
  const base = composeBase(linked);
  // Both at once: neither depends on the other, and this is polled.
  const [services, result] = await Promise.all([
    composeStatus(workspacePath, linked),
    spawnShellAsync(`${base} logs --tail 5 --no-color`, {
      timeout: 15_000,
      env: spawnEnv(),
      cwd: workspacePath,
    }),
  ]);
  const text = result.status === 0 ? (result.stdout ?? '') : '';
  // A hash rather than the text: this crosses IPC on every poll, and only
  // whether it changed is ever asked.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { services, logSignature: `${text.length}:${h.toString(16)}` };
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
  const base = composeBase(linked);
  // Follow-mode container logs: no daemon auto-start (fails fast when down).
  if (action === 'logs') {
    return `${base} logs -f --tail=200`;
  }
  // --remove-orphans: compose only manages the services named in the file it
  // is given, and bootstrap rewrites that file. A service the agent renames or
  // drops between runs is left running forever — still holding its port, so
  // the next `up` cannot bind it. Never --volumes here: Stop must not delete
  // the database. That belongs to deleting the project, and lives there.
  // --renew-anon-volumes: every generated stack mounts an anonymous volume over
  // node_modules (or the virtualenv) so the host checkout cannot shadow the
  // dependencies installed in the image. Compose fills that volume ONCE and
  // then hands it to each replacement container — "instead of retrieving data
  // from the previous containers" is precisely what this flag turns off — so
  // the moment a story adds a dependency, every later container starts against
  // the tree from the day the volume was created. The service exits on a
  // missing package, or worse: a web app whose own build tool is in that tree
  // finds no local copy, goes to the registry for one, and sits there
  // "running" with nothing behind the front door. The proxy answers 502, every
  // container reports up, and nothing a PM can press fixes it, because each
  // start hands back the same stale volume.
  //
  // Safe to do every time: an anonymous volume here is a copy of image
  // content, never data. Data lives in named volumes — the database — and this
  // flag does not touch those. Refilling from the image is a local copy of
  // files the build already produced.
  const up = `${base} up -d --build --renew-anon-volumes --remove-orphans`;
  const down = `${base} down --remove-orphans`;
  // Force stop: SIGKILL now rather than the polite SIGTERM-then-wait, for a
  // container that ignores the signal or takes minutes to drain. `kill` exits
  // non-zero when nothing is running, so the teardown must follow regardless
  // of its result — that is `;` in a shell and `&` in cmd.
  const alsoRun = IS_WIN ? '&' : ';';
  const forceDown = `${base} kill ${alsoRun} ${down}`;
  // Rebuild: images from scratch and containers recreated, using the files
  // that are already there. For a stack whose images were deleted, or one
  // whose containers no longer match what the compose file says. Volumes are
  // untouched, as everywhere else — this rebuilds the setup, not the data.
  //
  // Built BEFORE anything is stopped. A from-scratch build is the part most
  // likely to fail — a registry that times out, a package server that answers
  // 404, a laptop that went to sleep — and taking the app down first meant
  // that failure cost the PM the app that was working as well as the rebuild,
  // leaving nothing running while they worked out why. Building first costs
  // nothing when it succeeds (images are built either way) and costs nothing
  // when it fails either: the containers are still up on the old images.
  // Each step says what it is, because the log is what a PM sends us.
  const step = (text: string) => `echo ${shellQuote(`── ${text}`)}`;
  const rebuild =
    `${step('Building the images from scratch — this takes a few minutes')} && ` +
    `${base} build --no-cache && ` +
    `${step('Stopping the old containers')} && ${down} && ` +
    `${step('Starting the rebuilt app')} && ` +
    `${base} up -d --force-recreate --renew-anon-volumes --remove-orphans`;
  const compose =
    action === 'up'
      ? up
      : action === 'down'
        ? down
        : action === 'force-down'
          ? forceDown
          : action === 'rebuild'
            ? rebuild
            : `${down} && ${up}`;
  return `${ENSURE_DAEMON} && ${compose}`;
}

/**
 * Restart one service, picking up whatever its env file now says.
 *
 * `docker compose restart` is the obvious command and the wrong one: it stops
 * and starts the container it already has, environment and all, so a variable
 * just changed is read by nothing. The container has to be recreated for a new
 * value to reach the process inside it — which is why the button that appears
 * after saving a variable cannot be a restart in docker's sense of the word.
 *
 * `--no-deps` keeps it to the one service. Recreating a backend should not
 * take the database down with it, and the whole point of restarting one part
 * is that the rest of the stack stays up.
 */
export function restartServiceCommand(service: string, linked = false): string {
  // A compose service name and nothing else: this reaches a command line.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(service.trim())) {
    throw new Error('That is not a service name');
  }
  const base = composeBase(linked);
  // --build as well as --force-recreate: a value the app reads at startup is
  // picked up by recreating, but one baked into the image at build time — a
  // frontend that inlines its API address, an ARG in the Dockerfile — is not,
  // and the button would appear to work while changing nothing. With an
  // unchanged build context this costs a layer-cache hit and seconds.
  return (
    `${ENSURE_DAEMON} && echo ${shellQuote(`── restarting ${service.trim()}`)} && ` +
    `${base} up -d --build --force-recreate --no-deps ${shellQuote(service.trim())}`
  );
}

export function ideCommand(workspacePath: string, action: 'up' | 'down', port?: number): string {
  const name = ideContainerName(workspacePath);
  const legacy = legacyIdeContainerName(workspacePath);
  // Clear any container left from a previous run, ignoring "no such container",
  // then carry on regardless of that outcome — `&` is cmd's unconditional
  // separator, the counterpart of the shell's `;`.
  const quietlyThenContinue = IS_WIN ? '>NUL 2>&1 &' : '>/dev/null 2>&1;';
  if (action === 'down') {
    return `${ENSURE_DAEMON} && docker rm -f ${legacy} ${quietlyThenContinue} docker rm -f ${name}`;
  }
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65000) {
    throw new Error('A valid port is required to start the IDE');
  }
  // Published on loopback only. code-server runs with --auth none, so a plain
  // `-p port:8080` (every interface) handed an unauthenticated editor and
  // terminal over this repo to anyone on the same network.
  return (
    `${ENSURE_DAEMON} && docker rm -f ${legacy} ${quietlyThenContinue} ` +
    `docker rm -f ${name} ${quietlyThenContinue} ` +
    `docker run -d --name ${name} -p 127.0.0.1:${port}:8080 ` +
    `-v ${shellQuote(workspacePath)}:/home/coder/project ` +
    `codercom/code-server:latest --auth none --bind-addr 0.0.0.0:8080 /home/coder/project`
  );
}
