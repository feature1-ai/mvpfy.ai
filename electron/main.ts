import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CliStatus,
  CreateProjectResult,
  DEFAULT_STATE,
  McpFetchRequest,
  McpFetchResponse,
  MvpfyState,
  Project,
  REQUIRED_CLIS,
  RepoCloneOutcome,
  RepoFile,
  RunAgentRequest,
} from '../shared/types';

const MVPFY_HOME = path.join(os.homedir(), '.mvpfy');
const PROJECTS_DIR = path.join(MVPFY_HOME, 'projects');
const TMP_DIR = path.join(MVPFY_HOME, 'tmp');
const STATE_FILE = path.join(MVPFY_HOME, 'state.json');
const SECRETS_FILE = path.join(MVPFY_HOME, 'secrets.json');

// GUI apps on macOS get a minimal PATH; run commands through the user's login
// shell so tools installed via Homebrew/nvm/etc. are found.
const USER_SHELL = process.env.SHELL || '/bin/zsh';

let mainWindow: BrowserWindow | null = null;
const activeRuns = new Map<string, ChildProcess>();

function ensureDirs(): void {
  for (const dir of [MVPFY_HOME, PROJECTS_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readState(): MvpfyState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MvpfyState>;
    // Migrate pre-multi-repo projects ({repoUrl} → {repos: [{url, dir}]}).
    const projects = ((parsed.projects ?? []) as unknown as Array<Record<string, unknown>>).map((p) => {
      if (!p.repos && typeof p.repoUrl === 'string') {
        const { repoUrl, ...rest } = p;
        return { ...rest, repos: [{ url: repoUrl, dir: p.localPath }] };
      }
      return p;
    }) as unknown as Project[];
    return {
      tenant: parsed.tenant ?? null,
      projects,
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function writeState(state: MvpfyState): void {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Keychain (safeStorage-encrypted secrets file)
// ---------------------------------------------------------------------------

type SecretsMap = Record<string, string>;

function readSecrets(): SecretsMap {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as SecretsMap;
  } catch {
    return {};
  }
}

function keychainSet(entry: string, value: string): void {
  ensureDirs();
  const secrets = readSecrets();
  if (safeStorage.isEncryptionAvailable()) {
    secrets[entry] = safeStorage.encryptString(value).toString('base64');
  } else {
    // Fallback for environments without keychain access (e.g. some CI).
    secrets[entry] = Buffer.from(value, 'utf8').toString('base64');
  }
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

function keychainGet(entry: string): string | null {
  const stored = readSecrets()[entry];
  if (!stored) return null;
  const buf = Buffer.from(stored, 'base64');
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI checks
// ---------------------------------------------------------------------------

const AUTH_PROBES: Partial<Record<(typeof REQUIRED_CLIS)[number], string>> = {
  gh: 'gh auth status',
  claude: 'claude auth status',
  codex: 'codex login status',
};

function authCheck(name: (typeof REQUIRED_CLIS)[number], found: boolean): boolean | null {
  const probe = AUTH_PROBES[name];
  if (!probe || !found) return probe ? false : null;
  const result = spawnSync(USER_SHELL, ['-lc', probe], { encoding: 'utf8', timeout: 20_000 });
  if (name === 'claude') {
    return result.status === 0 && /"loggedIn":\s*true/.test(result.stdout);
  }
  return result.status === 0;
}

function cliCheck(): CliStatus[] {
  return REQUIRED_CLIS.map((name) => {
    const result = spawnSync(USER_SHELL, ['-lc', `command -v ${name}`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const found = result.status === 0 && result.stdout.trim().length > 0;
    return {
      name,
      found,
      path: found ? result.stdout.trim().split('\n')[0] : null,
      authenticated: authCheck(name, found),
    };
  });
}

// ---------------------------------------------------------------------------
// Streaming command runner
// ---------------------------------------------------------------------------

// Users often have `docker context use` pointing at a remote engine (ssh://…).
// mvpfy must never deploy there: pin every spawned command to a local engine.
let cachedLocalDockerContext: string | null | undefined;

function localDockerContext(): string | null {
  if (cachedLocalDockerContext !== undefined) return cachedLocalDockerContext;
  const result = spawnSync(USER_SHELL, ['-lc', 'docker context ls --format "{{.Name}}"'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const names =
    result.status === 0
      ? result.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];
  cachedLocalDockerContext = names.includes('desktop-linux')
    ? 'desktop-linux'
    : names.includes('default')
      ? 'default'
      : null;
  return cachedLocalDockerContext;
}

function spawnEnv(): NodeJS.ProcessEnv {
  const ctx = localDockerContext();
  return ctx ? { ...process.env, DOCKER_CONTEXT: ctx } : { ...process.env };
}

// If the local daemon is down, launch Docker Desktop and wait for it
// (PMs won't know the whale needs to be running first).
const ENSURE_DAEMON =
  'docker info >/dev/null 2>&1 || { echo "Docker is not running — starting Docker Desktop…"; ' +
  'open -a Docker >/dev/null 2>&1; ' +
  'for i in $(seq 1 45); do docker info >/dev/null 2>&1 && break; sleep 2; done; }';

function ideContainerName(workspacePath: string): string {
  const base = path
    .basename(workspacePath)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  return `mvpfy-ide-${base}`;
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startRun(runId: string, command: string, cwd: string): void {
  if (activeRuns.has(runId)) {
    throw new Error(`Run ${runId} is already active`);
  }
  sendToRenderer('run-output', { runId, stream: 'info', chunk: `$ ${command}\n` });
  const child = spawn(USER_SHELL, ['-lc', command], {
    cwd,
    env: spawnEnv(),
  });
  activeRuns.set(runId, child);

  child.stdout?.on('data', (data: Buffer) => {
    sendToRenderer('run-output', { runId, stream: 'stdout', chunk: data.toString('utf8') });
  });
  child.stderr?.on('data', (data: Buffer) => {
    sendToRenderer('run-output', { runId, stream: 'stderr', chunk: data.toString('utf8') });
  });
  child.on('error', (err) => {
    sendToRenderer('run-output', { runId, stream: 'stderr', chunk: `spawn error: ${err.message}\n` });
  });
  child.on('close', (code) => {
    activeRuns.delete(runId);
    sendToRenderer('run-exit', { runId, code });
  });
}

function runAgent(req: RunAgentRequest): void {
  const repoPath = path.resolve(req.repoPath);
  if (!repoPath.startsWith(PROJECTS_DIR + path.sep)) {
    throw new Error('Agent runs are restricted to managed project directories under ~/.mvpfy/projects');
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }
  ensureDirs();
  const promptFile = path.join(TMP_DIR, `prompt-${req.runId}.txt`);
  fs.writeFileSync(promptFile, req.promptText, 'utf8');

  const q = shellQuote;
  let command: string;
  if (req.agent === 'claude') {
    // -p (print) reads the prompt from stdin; stream-json gives per-event
    // output for the live log panel. Permissions are bypassed because the
    // ship-feature flow must run unattended (the PM reviews outputs, not
    // individual tool calls), and the process is confined to the cloned repo.
    command = `cd ${q(repoPath)} && claude -p --verbose --output-format stream-json --dangerously-skip-permissions < ${q(promptFile)}`;
  } else {
    const model = req.model || DEFAULT_STATE.settings.codexModel;
    command = `cd ${q(repoPath)} && codex exec --model ${q(model)} --sandbox danger-full-access --skip-git-repo-check --json - < ${q(promptFile)}`;
  }
  startRun(req.runId, command, repoPath);
}

// ---------------------------------------------------------------------------
// Repo management
// ---------------------------------------------------------------------------

function slugFromRepoUrl(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '');
  const last = cleaned.split(/[/:]/).filter(Boolean).pop() || 'project';
  return last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function gitClone(repoUrl: string, dest: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(USER_SHELL, ['-lc', `git clone ${shellQuote(repoUrl)} ${shellQuote(dest)}`], {
      cwd: PROJECTS_DIR,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `git clone exited with code ${code}` });
    });
  });
}

/**
 * Create a project workspace. A single URL is cloned directly as the workspace
 * root; multiple URLs get a shared workspace folder with one subdirectory per
 * repo, so one compose file at the root can run the whole stack.
 */
async function createProject(repoUrls: string[]): Promise<CreateProjectResult> {
  ensureDirs();
  const urls = repoUrls.map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    return { ok: false, slug: '', workspacePath: '', repos: [], error: 'No repo URLs given' };
  }
  const baseSlug =
    urls.length === 1 ? slugFromRepoUrl(urls[0]) : `${slugFromRepoUrl(urls[0])}-stack`;
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(path.join(PROJECTS_DIR, slug))) {
    slug = `${baseSlug}-${n++}`;
  }
  const workspacePath = path.join(PROJECTS_DIR, slug);
  const repos: RepoCloneOutcome[] = [];

  if (urls.length === 1) {
    const res = await gitClone(urls[0], workspacePath);
    repos.push({ url: urls[0], dir: workspacePath, ...res });
  } else {
    fs.mkdirSync(workspacePath, { recursive: true });
    const used = new Set<string>();
    for (const url of urls) {
      const repoSlugBase = slugFromRepoUrl(url);
      let repoSlug = repoSlugBase;
      let m = 2;
      while (used.has(repoSlug)) repoSlug = `${repoSlugBase}-${m++}`;
      used.add(repoSlug);
      const dir = path.join(workspacePath, repoSlug);
      const res = await gitClone(url, dir);
      repos.push({ url, dir, ...res });
    }
  }

  const failed = repos.filter((r) => !r.ok);
  if (failed.length > 0) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    return {
      ok: false,
      slug,
      workspacePath,
      repos,
      error: failed.map((r) => `${r.url}: ${r.error}`).join('\n'),
    };
  }
  return { ok: true, slug, workspacePath, repos };
}

function readRepoFiles(repoPath: string, relativePaths: string[]): RepoFile[] {
  const root = path.resolve(repoPath);
  return relativePaths.map((rel) => {
    const abs = path.resolve(root, rel);
    // Prevent path traversal outside the repo.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { relativePath: rel, exists: false, content: null };
    }
    try {
      const content = fs.readFileSync(abs, 'utf8');
      return { relativePath: rel, exists: true, content };
    } catch {
      return { relativePath: rel, exists: false, content: null };
    }
  });
}

function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  const root = path.resolve(repoPath);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Refusing to write outside the repo');
  }
  fs.writeFileSync(abs, content, 'utf8');
}

/**
 * Delete a project workspace: tear down its Docker stack (containers and
 * volumes) if a compose file exists, then remove the directory.
 */
async function deleteProject(workspacePath: string): Promise<{ ok: boolean; error?: string }> {
  const resolved = path.resolve(workspacePath);
  if (!resolved.startsWith(PROJECTS_DIR + path.sep) || resolved === PROJECTS_DIR) {
    return { ok: false, error: 'Refusing to delete outside ~/.mvpfy/projects' };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: true };
  }
  try {
    // Remove the project's IDE container if one was launched.
    await new Promise<void>((resolve) => {
      const child = spawn(USER_SHELL, ['-lc', `docker rm -f ${ideContainerName(resolved)}`], {
        env: spawnEnv(),
      });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
    if (fs.existsSync(path.join(resolved, 'docker-compose.mvpfy.yml'))) {
      await new Promise<void>((resolve) => {
        const child = spawn(
          USER_SHELL,
          ['-lc', 'docker compose -f docker-compose.mvpfy.yml down --volumes --remove-orphans'],
          { cwd: resolved, env: spawnEnv() }
        );
        child.on('error', () => resolve());
        child.on('close', () => resolve());
      });
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Find a free localhost port, starting at `start` and walking upward. */
function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > 65000) {
        reject(new Error('No free port found'));
        return;
      }
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    tryPort(Math.max(1024, start));
  });
}

/** Check whether a local URL answers HTTP at all (any status counts as up). */
async function probeUrl(url: string): Promise<{ reachable: boolean; status: number }> {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
    ) {
      return { reachable: false, status: 0 };
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return { reachable: true, status: res.status };
  } catch {
    return { reachable: false, status: 0 };
  }
}

// ---------------------------------------------------------------------------
// Feature1 MCP fetch proxy (runs in main to avoid renderer CORS limits)
// ---------------------------------------------------------------------------

async function mcpFetch(req: McpFetchRequest): Promise<McpFetchResponse> {
  try {
    const url = new URL(req.url);
    if (url.protocol !== 'https:') {
      return { ok: false, status: 0, body: '', error: 'Only https URLs are allowed' };
    }
    const res = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers,
      body: req.body,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Window + IPC wiring
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    title: 'mvpfy',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Needed for the embedded Preview/IDE panes (<webview> tags).
      webviewTag: true,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('cli-check', () => cliCheck());
  ipcMain.handle('read-state', () => readState());
  ipcMain.handle('write-state', (_ev, state: MvpfyState) => writeState(state));
  ipcMain.handle('keychain-get', (_ev, entry: string) => keychainGet(entry));
  ipcMain.handle('keychain-set', (_ev, entry: string, value: string) => keychainSet(entry, value));
  ipcMain.handle('open-external', (_ev, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http(s) URLs can be opened');
    }
    return shell.openExternal(url);
  });
  ipcMain.handle('create-project', (_ev, repoUrls: string[]) => createProject(repoUrls));
  ipcMain.handle('delete-project', (_ev, workspacePath: string) => deleteProject(workspacePath));
  ipcMain.handle('run-agent', (_ev, req: RunAgentRequest) => runAgent(req));
  ipcMain.handle('stop-run', (_ev, runId: string) => {
    const child = activeRuns.get(runId);
    if (child) child.kill('SIGTERM');
  });
  ipcMain.handle('docker-compose', (_ev, runId: string, repoPath: string, action: 'up' | 'down') => {
    const resolved = path.resolve(repoPath);
    if (!resolved.startsWith(PROJECTS_DIR + path.sep)) {
      throw new Error('docker compose is restricted to managed project directories');
    }
    const compose =
      action === 'up'
        ? 'docker compose -f docker-compose.mvpfy.yml up -d --build'
        : 'docker compose -f docker-compose.mvpfy.yml down';
    startRun(runId, `${ENSURE_DAEMON} && ${compose}`, resolved);
  });
  ipcMain.handle(
    'ide',
    (_ev, runId: string, workspacePath: string, action: 'up' | 'down', port?: number) => {
      const resolved = path.resolve(workspacePath);
      if (!resolved.startsWith(PROJECTS_DIR + path.sep)) {
        throw new Error('IDE containers are restricted to managed project directories');
      }
      const name = ideContainerName(resolved);
      let command: string;
      if (action === 'up') {
        if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65000) {
          throw new Error('A valid port is required to start the IDE');
        }
        command =
          `docker rm -f ${name} >/dev/null 2>&1; ` +
          `docker run -d --name ${name} -p ${port}:8080 ` +
          `-v ${shellQuote(resolved)}:/home/coder/project ` +
          `codercom/code-server:latest --auth none --bind-addr 0.0.0.0:8080 /home/coder/project`;
      } else {
        command = `docker rm -f ${name}`;
      }
      startRun(runId, `${ENSURE_DAEMON} && ${command}`, resolved);
    }
  );
  ipcMain.handle('read-repo-files', (_ev, repoPath: string, relativePaths: string[]) =>
    readRepoFiles(repoPath, relativePaths)
  );
  ipcMain.handle('write-repo-file', (_ev, repoPath: string, relativePath: string, content: string) =>
    writeRepoFile(repoPath, relativePath, content)
  );
  ipcMain.handle('find-free-port', (_ev, start: number) => findFreePort(start));
  ipcMain.handle('probe-url', (_ev, url: string) => probeUrl(url));
  ipcMain.handle('mcp-fetch', (_ev, req: McpFetchRequest) => mcpFetch(req));
}

app.whenReady().then(() => {
  ensureDirs();
  registerIpc();
  // Brand the dock in dev; packaged builds use build/icon.icns.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(app.getAppPath(), 'assets', 'icon.png'));
    } catch {
      // Non-fatal: fall back to the default Electron icon.
    }
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const child of activeRuns.values()) {
    child.kill('SIGTERM');
  }
  if (process.platform !== 'darwin') app.quit();
});
