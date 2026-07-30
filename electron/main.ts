import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CliStatus,
  CloneResult,
  DEFAULT_STATE,
  McpFetchRequest,
  McpFetchResponse,
  MvpfyState,
  REQUIRED_CLIS,
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
    return {
      tenant: parsed.tenant ?? null,
      projects: parsed.projects ?? [],
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

function cliCheck(): CliStatus[] {
  return REQUIRED_CLIS.map((name) => {
    const result = spawnSync(USER_SHELL, ['-lc', `command -v ${name}`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const found = result.status === 0 && result.stdout.trim().length > 0;
    return { name, found, path: found ? result.stdout.trim().split('\n')[0] : null };
  });
}

// ---------------------------------------------------------------------------
// Streaming command runner
// ---------------------------------------------------------------------------

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
    env: { ...process.env },
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
    command = `cd ${q(repoPath)} && claude code --repo ${q(repoPath)} --prompt-file ${q(promptFile)}`;
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

async function cloneRepo(repoUrl: string): Promise<CloneResult> {
  ensureDirs();
  const baseSlug = slugFromRepoUrl(repoUrl);
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(path.join(PROJECTS_DIR, slug))) {
    slug = `${baseSlug}-${n++}`;
  }
  const localPath = path.join(PROJECTS_DIR, slug);
  return await new Promise<CloneResult>((resolve) => {
    const child = spawn(USER_SHELL, ['-lc', `git clone ${shellQuote(repoUrl)} ${shellQuote(localPath)}`], {
      cwd: PROJECTS_DIR,
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ ok: false, localPath, slug, error: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, localPath, slug });
      } else {
        resolve({ ok: false, localPath, slug, error: stderr.trim() || `git clone exited with code ${code}` });
      }
    });
  });
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
  ipcMain.handle('clone-repo', (_ev, repoUrl: string) => cloneRepo(repoUrl));
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
    const command =
      action === 'up'
        ? 'docker compose -f docker-compose.mvpfy.yml up -d'
        : 'docker compose -f docker-compose.mvpfy.yml down';
    startRun(runId, command, resolved);
  });
  ipcMain.handle('read-repo-files', (_ev, repoPath: string, relativePaths: string[]) =>
    readRepoFiles(repoPath, relativePaths)
  );
  ipcMain.handle('mcp-fetch', (_ev, req: McpFetchRequest) => mcpFetch(req));
}

app.whenReady().then(() => {
  ensureDirs();
  registerIpc();
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
