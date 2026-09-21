import { app, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BlankProjectRemote,
  ComposeAction,
  McpFetchRequest,
  MvpfyState,
  RunAgentRequest,
} from '../shared/types';
import { ensureDirs, isAllowedWorkspace, isLinkedPath, isManagedPath, TMP_DIR } from './paths';
import { removeQuietly, runAgent, runToolingAgent } from './services/agents';
import {
  agentModels,
  cliCheck,
  loginCommand,
  mcpAddCommand,
  signInAllCommand,
} from './services/cli';
import {
  composeCommand,
  composeProgress,
  composeStatus,
  ideCommand,
  ideStatus,
  seedCommandFor,
} from './services/docker';
import { installAllCommand, installCommand, installPlans } from './services/install';
import { findFreePort, mcpFetch, probeUrl } from './services/net';
import {
  createBlankProject,
  createProject,
  workspaceIsEmpty,
  deleteProject,
  linkProject,
  addRemoteCommand,
  readRepoBranches,
  readRepoRemotes,
  readRepoFiles,
  addWorktrees,
  checkoutFeature,
  commitFeatureWorkCommand,
  featureCheckedOut,
  featureGitStatus,
  mergeTrunkCommand,
  raisePrCommand,
  removeWorktrees,
  repoSyncCommand,
  writeRepoFile,
} from './services/projects';
import { startRun, stopRun } from './services/runs';
import { openTerminalCommand, spawnShell } from './services/shell';
import { keychainGet, keychainSet } from './services/secrets';
import { readState, writeState } from './services/store';
import { checkForUpdates, installUpdate } from './services/updates';

/** Controller layer: routes renderer IPC calls to the service modules. */
export function registerIpc(): void {
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('cli-check', () => cliCheck());
  ipcMain.handle('agent-models', (_ev, agent: 'claude' | 'codex') => agentModels(agent));
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
  ipcMain.handle('create-project', (_ev, repoUrls: string[], link?: boolean) =>
    link ? linkProject(repoUrls[0] ?? '') : createProject(repoUrls)
  );
  ipcMain.handle('create-blank-project', (_ev, name: string, remote: BlankProjectRemote) =>
    createBlankProject(name, remote)
  );
  ipcMain.handle('workspace-empty', (_ev, dirs: string[]) => workspaceIsEmpty(dirs));
  ipcMain.handle('pick-directory', async () => {
    // multiSelections: a project is often several repos side by side, so let
    // the user pick them all in one pass rather than reopening the dialog.
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      message: 'Choose one or more local git repositories',
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('delete-project', (_ev, workspacePath: string) => deleteProject(workspacePath));
  ipcMain.handle('run-agent', (_ev, req: RunAgentRequest) => runAgent(req));
  ipcMain.handle('stop-run', (_ev, runId: string) => stopRun(runId));
  ipcMain.handle(
    'docker-compose',
    (_ev, runId: string, repoPath: string, action: ComposeAction) => {
      const resolved = path.resolve(repoPath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('docker compose is restricted to managed and linked project directories');
      }
      const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
      startRun(runId, composeCommand(action, linked), resolved);
    }
  );
  ipcMain.handle(
    'ide',
    (_ev, runId: string, workspacePath: string, action: 'up' | 'down', port?: number) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('IDE containers are restricted to managed and linked project directories');
      }
      startRun(runId, ideCommand(resolved, action, port), resolved);
    }
  );
  ipcMain.handle('seed', (_ev, runId: string, workspacePath: string) => {
    const resolved = path.resolve(workspacePath);
    if (!isAllowedWorkspace(resolved)) {
      throw new Error('Seeding is restricted to managed and linked project directories');
    }
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    const command = seedCommandFor(resolved, linked);
    if (!command) return false;
    startRun(runId, command, resolved);
    return true;
  });
  ipcMain.handle('compose-status', (_ev, workspacePath: string) => {
    const resolved = path.resolve(workspacePath);
    if (!isAllowedWorkspace(resolved)) {
      throw new Error('docker compose is restricted to managed and linked project directories');
    }
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    return composeStatus(resolved, linked);
  });
  ipcMain.handle('compose-progress', (_ev, workspacePath: string) => {
    const resolved = path.resolve(workspacePath);
    if (!isAllowedWorkspace(resolved)) {
      throw new Error('docker compose is restricted to managed and linked project directories');
    }
    const linked = isLinkedPath(resolved) && !isManagedPath(resolved);
    return composeProgress(resolved, linked);
  });
  ipcMain.handle('ide-status', (_ev, workspacePath: string) => {
    const resolved = path.resolve(workspacePath);
    if (!isAllowedWorkspace(resolved)) {
      throw new Error('IDE containers are restricted to managed and linked project directories');
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
  ipcMain.handle('repo-remotes', (_ev, dirs: string[]) => readRepoRemotes(dirs));
  ipcMain.handle(
    'add-remote',
    (_ev, runId: string, workspacePath: string, dir: string, url: string) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('Remotes can only be set on managed and linked project directories');
      }
      startRun(runId, addRemoteCommand(dir, url), resolved);
    }
  );
  ipcMain.handle('repo-sync', (_ev, runId: string, workspacePath: string, dirs: string[]) => {
    const resolved = path.resolve(workspacePath);
    if (!isAllowedWorkspace(resolved)) {
      throw new Error('Sync is restricted to managed and linked project directories');
    }
    startRun(runId, repoSyncCommand(dirs), resolved);
  });
  ipcMain.handle(
    'feature-git-status',
    (
      _ev,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string
    ) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('Reading is restricted to managed and linked project directories');
      }
      return featureGitStatus(dirs, projectKey, featureSlug, branch);
    }
  );
  ipcMain.handle(
    'commit-feature-work',
    (
      _ev,
      runId: string,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string,
      message: string
    ) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('Committing is restricted to managed and linked project directories');
      }
      startRun(
        runId,
        commitFeatureWorkCommand(dirs, projectKey, featureSlug, branch, message),
        resolved
      );
    }
  );
  ipcMain.handle(
    'merge-trunk',
    (
      _ev,
      runId: string,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string
    ) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('Merge is restricted to managed and linked project directories');
      }
      const command = mergeTrunkCommand(projectKey, featureSlug, dirs, branch);
      // Nothing to merge is not a failure — the feature may have no checkout in
      // any repository yet. Still a run, so the caller settles either way.
      startRun(
        runId,
        command || `echo ${JSON.stringify('Nothing to merge — this feature has no checkout yet.')}`,
        resolved
      );
    }
  );
  ipcMain.handle(
    'raise-pr',
    (
      _ev,
      runId: string,
      workspacePath: string,
      dirs: string[],
      branch: string,
      title: string,
      body: string
    ) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('Pull requests are restricted to managed and linked project directories');
      }
      // The body goes to disk rather than onto the command line: it is many
      // lines, and a newline inside a quoted argument ends the command on
      // cmd.exe. Built first — a raise with nothing to push throws here, and
      // then no file has been written to clean up.
      ensureDirs();
      const bodyFile = path.join(TMP_DIR, `pr-body-${runId}.md`);
      const command = raisePrCommand(dirs, branch, title, bodyFile);
      fs.writeFileSync(bodyFile, body, 'utf8');
      startRun(runId, command, resolved, () => removeQuietly([bodyFile]));
    }
  );
  ipcMain.handle(
    'worktree',
    (
      _ev,
      workspacePath: string,
      dirs: string[],
      projectKey: string,
      featureSlug: string,
      branch: string,
      action: 'add' | 'remove'
    ) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('Worktrees are restricted to managed and linked project directories');
      }
      return action === 'add'
        ? addWorktrees(projectKey, featureSlug, dirs, branch)
        : removeWorktrees(projectKey, featureSlug, dirs);
    }
  );
  ipcMain.handle(
    'checkout-feature',
    (_ev, workspacePath: string, dirs: string[], branch: string | null) => {
      const resolved = path.resolve(workspacePath);
      if (!isAllowedWorkspace(resolved)) {
        throw new Error('Checkout is restricted to managed and linked project directories');
      }
      return checkoutFeature(dirs, branch);
    }
  );
  ipcMain.handle('feature-checked-out', (_ev, dirs: string[], branch: string) =>
    featureCheckedOut(dirs, branch)
  );
  ipcMain.handle('cli-login', (_ev, runId: string, tool: string) =>
    startRun(runId, loginCommand(tool), TMP_DIR)
  );
  ipcMain.handle('sign-in-all', (_ev, runId: string, tools: string[]) =>
    startRun(runId, signInAllCommand(tools), TMP_DIR)
  );
  ipcMain.handle('mcp-register', (_ev, runId: string, name: string, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Only https MCP servers can be registered');
    startRun(runId, mcpAddCommand(name, url), TMP_DIR);
  });
  ipcMain.handle('open-terminal', (_ev, workspacePath: string) => {
    const resolved = path.resolve(workspacePath);
    if (!isAllowedWorkspace(resolved)) {
      throw new Error('Terminals are restricted to managed and linked project directories');
    }
    // Detached and unwatched: it is the user's shell now, not a run of ours.
    spawnShell(openTerminalCommand(resolved), { cwd: resolved, detached: true }).unref();
  });
  ipcMain.handle('install-plans', () => installPlans());
  ipcMain.handle('install-all', (_ev, runId: string, tools: string[]) =>
    startRun(runId, installAllCommand(tools), TMP_DIR)
  );
  // Installing the tooling has no project behind it — it is what happens
  // before there is one.
  ipcMain.handle('install-tools-agent', (_ev, req: RunAgentRequest) => runToolingAgent(req));
  ipcMain.handle('install-tool', (_ev, runId: string, tool: string) =>
    startRun(runId, installCommand(tool), TMP_DIR)
  );
  ipcMain.handle('find-free-port', (_ev, start: number) => findFreePort(start));
  ipcMain.handle('probe-url', (_ev, url: string) => probeUrl(url));
  ipcMain.handle('mcp-fetch', (_ev, req: McpFetchRequest) => mcpFetch(req));
  ipcMain.handle('check-for-updates', () => checkForUpdates());
  ipcMain.handle('install-update', () => installUpdate());
}
