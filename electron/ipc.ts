import { dialog, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { McpFetchRequest, MvpfyState, RunAgentRequest } from '../shared/types';
import { isManagedPath, TMP_DIR } from './paths';
import { runAgent } from './services/agents';
import { cliCheck } from './services/cli';
import { composeCommand, ideCommand, ideStatus } from './services/docker';
import { findFreePort, mcpFetch, probeUrl } from './services/net';
import {
  createProject,
  deleteProject,
  readRepoBranches,
  readRepoFiles,
  writeRepoFile,
} from './services/projects';
import { startRun, stopRun } from './services/runs';
import { keychainGet, keychainSet } from './services/secrets';
import { readState, writeState } from './services/store';
import { installUpdate } from './services/updates';

/** Controller layer: routes renderer IPC calls to the service modules. */
export function registerIpc(): void {
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
  ipcMain.handle('pick-directory', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      message: 'Choose a local git repository',
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle('delete-project', (_ev, workspacePath: string) => deleteProject(workspacePath));
  ipcMain.handle('run-agent', (_ev, req: RunAgentRequest) => runAgent(req));
  ipcMain.handle('stop-run', (_ev, runId: string) => stopRun(runId));
  ipcMain.handle(
    'docker-compose',
    (_ev, runId: string, repoPath: string, action: 'up' | 'down' | 'restart' | 'logs') => {
      const resolved = path.resolve(repoPath);
      if (!isManagedPath(resolved)) {
        throw new Error('docker compose is restricted to managed project directories');
      }
      startRun(runId, composeCommand(action), resolved);
    }
  );
  ipcMain.handle(
    'ide',
    (_ev, runId: string, workspacePath: string, action: 'up' | 'down', port?: number) => {
      const resolved = path.resolve(workspacePath);
      if (!isManagedPath(resolved)) {
        throw new Error('IDE containers are restricted to managed project directories');
      }
      startRun(runId, ideCommand(resolved, action, port), resolved);
    }
  );
  ipcMain.handle('ide-status', (_ev, workspacePath: string) => {
    const resolved = path.resolve(workspacePath);
    if (!isManagedPath(resolved)) {
      throw new Error('IDE containers are restricted to managed project directories');
    }
    return ideStatus(resolved);
  });
  ipcMain.handle('read-repo-files', (_ev, repoPath: string, relativePaths: string[]) =>
    readRepoFiles(repoPath, relativePaths)
  );
  ipcMain.handle(
    'write-repo-file',
    (_ev, repoPath: string, relativePath: string, content: string) =>
      writeRepoFile(repoPath, relativePath, content)
  );
  ipcMain.handle('repo-branches', (_ev, dirs: string[]) => readRepoBranches(dirs));
  ipcMain.handle('repo-sync', (_ev, runId: string, workspacePath: string, dirs: string[]) => {
    const resolved = path.resolve(workspacePath);
    if (!isManagedPath(resolved)) {
      throw new Error('Sync is restricted to managed project directories');
    }
    const parts = dirs.map((d) => {
      const dir = path.resolve(d);
      if (!isManagedPath(dir)) throw new Error('Sync is restricted to managed project directories');
      return `echo "── ${path.basename(dir)}" && git -C "${dir}" pull --ff-only`;
    });
    startRun(runId, parts.join(' && '), resolved);
  });
  ipcMain.handle('cli-login', (_ev, runId: string, tool: string) => {
    // In-app sign-in for tools whose login flows survive without a TTY. The
    // output streams to the renderer so device codes/URLs are visible.
    const commands: Record<string, string> = {
      gh: 'gh auth login --hostname github.com --git-protocol https --web',
      codex: 'codex login',
    };
    const command = commands[tool];
    if (!command) throw new Error(`No in-app sign-in for "${tool}"`);
    startRun(runId, command, TMP_DIR);
  });
  ipcMain.handle('find-free-port', (_ev, start: number) => findFreePort(start));
  ipcMain.handle('probe-url', (_ev, url: string) => probeUrl(url));
  ipcMain.handle('mcp-fetch', (_ev, req: McpFetchRequest) => mcpFetch(req));
  ipcMain.handle('install-update', () => installUpdate());
}
