import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  AgentKind,
  ComposeAction,
  McpFetchRequest,
  MvpfyApi,
  MvpfyState,
  RunAgentRequest,
  RunExitEvent,
  RunOutputEvent,
  UpdateStatus,
} from '../shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_ev: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: MvpfyApi = {
  appVersion: () => ipcRenderer.invoke('app-version'),
  cliCheck: () => ipcRenderer.invoke('cli-check'),
  agentModels: (agent: AgentKind) => ipcRenderer.invoke('agent-models', agent),
  readState: () => ipcRenderer.invoke('read-state'),
  writeState: (state: MvpfyState) => ipcRenderer.invoke('write-state', state),
  keychainGet: (entry: string) => ipcRenderer.invoke('keychain-get', entry),
  keychainSet: (entry: string, value: string) => ipcRenderer.invoke('keychain-set', entry, value),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  createProject: (repoUrls: string[], link?: boolean) =>
    ipcRenderer.invoke('create-project', repoUrls, link),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  deleteProject: (workspacePath: string) => ipcRenderer.invoke('delete-project', workspacePath),
  runAgent: (req: RunAgentRequest) => ipcRenderer.invoke('run-agent', req),
  stopRun: (runId: string) => ipcRenderer.invoke('stop-run', runId),
  dockerCompose: (runId: string, repoPath: string, action: ComposeAction) =>
    ipcRenderer.invoke('docker-compose', runId, repoPath, action),
  ide: (runId: string, workspacePath: string, action: 'up' | 'down', port?: number) =>
    ipcRenderer.invoke('ide', runId, workspacePath, action, port),
  ideStatus: (workspacePath: string) => ipcRenderer.invoke('ide-status', workspacePath),
  cliLogin: (runId: string, tool: string) => ipcRenderer.invoke('cli-login', runId, tool),
  registerMcpServer: (runId: string, name: string, url: string) =>
    ipcRenderer.invoke('mcp-register', runId, name, url),
  installPlans: () => ipcRenderer.invoke('install-plans'),
  installTool: (runId: string, tool: string) => ipcRenderer.invoke('install-tool', runId, tool),
  readRepoFiles: (repoPath: string, relativePaths: string[]) =>
    ipcRenderer.invoke('read-repo-files', repoPath, relativePaths),
  writeRepoFile: (repoPath: string, relativePath: string, content: string) =>
    ipcRenderer.invoke('write-repo-file', repoPath, relativePath, content),
  repoBranches: (dirs: string[]) => ipcRenderer.invoke('repo-branches', dirs),
  raisePullRequests: (
    runId: string,
    workspacePath: string,
    dirs: string[],
    branch: string,
    title: string,
    body: string
  ) => ipcRenderer.invoke('raise-pr', runId, workspacePath, dirs, branch, title, body),
  worktree: (
    workspacePath: string,
    dirs: string[],
    projectKey: string,
    featureSlug: string,
    branch: string,
    action: 'add' | 'remove'
  ) => ipcRenderer.invoke('worktree', workspacePath, dirs, projectKey, featureSlug, branch, action),
  checkoutFeature: (workspacePath: string, dirs: string[], branch: string | null) =>
    ipcRenderer.invoke('checkout-feature', workspacePath, dirs, branch),
  repoSync: (runId: string, workspacePath: string, dirs: string[]) =>
    ipcRenderer.invoke('repo-sync', runId, workspacePath, dirs),
  findFreePort: (start: number) => ipcRenderer.invoke('find-free-port', start),
  probeUrl: (url: string) => ipcRenderer.invoke('probe-url', url),
  mcpFetch: (req: McpFetchRequest) => ipcRenderer.invoke('mcp-fetch', req),
  onRunOutput: (cb: (ev: RunOutputEvent) => void) => subscribe('run-output', cb),
  onRunExit: (cb: (ev: RunExitEvent) => void) => subscribe('run-exit', cb),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => subscribe('update-status', cb),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
};

contextBridge.exposeInMainWorld('mvpfy', api);
