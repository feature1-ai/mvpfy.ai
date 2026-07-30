import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  McpFetchRequest,
  MvpfyApi,
  MvpfyState,
  RunAgentRequest,
  RunExitEvent,
  RunOutputEvent,
} from '../shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_ev: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: MvpfyApi = {
  cliCheck: () => ipcRenderer.invoke('cli-check'),
  readState: () => ipcRenderer.invoke('read-state'),
  writeState: (state: MvpfyState) => ipcRenderer.invoke('write-state', state),
  keychainGet: (entry: string) => ipcRenderer.invoke('keychain-get', entry),
  keychainSet: (entry: string, value: string) => ipcRenderer.invoke('keychain-set', entry, value),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  cloneRepo: (repoUrl: string) => ipcRenderer.invoke('clone-repo', repoUrl),
  runAgent: (req: RunAgentRequest) => ipcRenderer.invoke('run-agent', req),
  stopRun: (runId: string) => ipcRenderer.invoke('stop-run', runId),
  dockerCompose: (runId: string, repoPath: string, action: 'up' | 'down') =>
    ipcRenderer.invoke('docker-compose', runId, repoPath, action),
  readRepoFiles: (repoPath: string, relativePaths: string[]) =>
    ipcRenderer.invoke('read-repo-files', repoPath, relativePaths),
  mcpFetch: (req: McpFetchRequest) => ipcRenderer.invoke('mcp-fetch', req),
  onRunOutput: (cb: (ev: RunOutputEvent) => void) => subscribe('run-output', cb),
  onRunExit: (cb: (ev: RunExitEvent) => void) => subscribe('run-exit', cb),
};

contextBridge.exposeInMainWorld('mvpfy', api);
