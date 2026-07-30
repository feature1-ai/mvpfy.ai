// Types shared between the Electron main process and the renderer.

export type AgentKind = 'claude' | 'codex';

export type ProjectStatus =
  | 'cloned'
  | 'bootstrapping'
  | 'needs-review'
  | 'running'
  | 'stopped'
  | 'error';

export interface Project {
  id: string;
  repoUrl: string;
  localPath: string;
  basePort: number;
  status: ProjectStatus;
  lastStoryId: string | null;
  generatedFiles: string[];
}

export interface TenantConfig {
  slug: string;
  host: string;
  tokenKeychainEntry: string;
}

export interface Settings {
  defaultAgent: AgentKind;
  codexModel: string;
}

export interface MvpfyState {
  tenant: TenantConfig | null;
  projects: Project[];
  settings: Settings;
}

export const DEFAULT_STATE: MvpfyState = {
  tenant: null,
  projects: [],
  settings: {
    defaultAgent: 'claude',
    codexModel: 'gpt-5.3-codex',
  },
};

export const REQUIRED_CLIS = ['git', 'gh', 'docker', 'claude', 'codex'] as const;
export type CliName = (typeof REQUIRED_CLIS)[number];

export interface CliStatus {
  name: CliName;
  found: boolean;
  path: string | null;
}

export interface CloneResult {
  ok: boolean;
  localPath: string;
  slug: string;
  error?: string;
}

export interface RunAgentRequest {
  /** Unique id used to correlate streamed output events. */
  runId: string;
  agent: AgentKind;
  repoPath: string;
  promptText: string;
  /** Codex only. */
  model?: string;
}

export interface RunOutputEvent {
  runId: string;
  stream: 'stdout' | 'stderr' | 'info';
  chunk: string;
}

export interface RunExitEvent {
  runId: string;
  code: number | null;
}

export interface RepoFile {
  relativePath: string;
  exists: boolean;
  content: string | null;
}

export interface McpFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface McpFetchResponse {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

/** Files the bootstrap agent is expected to generate. */
export const GENERATED_FILES = [
  'mvpfy.yml',
  'Dockerfile',
  'docker-compose.mvpfy.yml',
  '.env.mvpfy.example',
  'mvpfy-run.md',
] as const;

/** API surface exposed to the renderer through the preload contextBridge. */
export interface MvpfyApi {
  cliCheck(): Promise<CliStatus[]>;
  readState(): Promise<MvpfyState>;
  writeState(state: MvpfyState): Promise<void>;
  keychainGet(entry: string): Promise<string | null>;
  keychainSet(entry: string, value: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  cloneRepo(repoUrl: string): Promise<CloneResult>;
  runAgent(req: RunAgentRequest): Promise<void>;
  stopRun(runId: string): Promise<void>;
  dockerCompose(runId: string, repoPath: string, action: 'up' | 'down'): Promise<void>;
  readRepoFiles(repoPath: string, relativePaths: string[]): Promise<RepoFile[]>;
  mcpFetch(req: McpFetchRequest): Promise<McpFetchResponse>;
  onRunOutput(cb: (ev: RunOutputEvent) => void): () => void;
  onRunExit(cb: (ev: RunExitEvent) => void): () => void;
}
