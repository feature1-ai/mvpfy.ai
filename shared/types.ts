// Types shared between the Electron main process and the renderer.

export type AgentKind = 'claude' | 'codex';

export type ProjectStatus =
  'cloned' | 'bootstrapping' | 'needs-review' | 'running' | 'stopped' | 'error';

export interface RepoRef {
  url: string;
  /** Absolute path of the clone. Equals localPath for single-repo projects. */
  dir: string;
}

export interface Project {
  id: string;
  repos: RepoRef[];
  /** Workspace root: where generated files and the compose file live. */
  localPath: string;
  basePort: number;
  status: ProjectStatus;
  lastStoryId: string | null;
  generatedFiles: string[];
  /** Port of the running code-server IDE container, if launched. */
  idePort?: number | null;
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
  /** true/false for CLIs with a login (gh, claude, codex); null when N/A. */
  authenticated: boolean | null;
}

export interface RepoCloneOutcome {
  url: string;
  dir: string;
  ok: boolean;
  error?: string;
}

export interface CreateProjectResult {
  ok: boolean;
  slug: string;
  workspacePath: string;
  repos: RepoCloneOutcome[];
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

/** The bootstrap agent writes questions here when it is blocked on PM input. */
export const QUESTIONS_FILE = 'mvpfy-questions.md';
/** PM answers are saved here; the agent reads them on the next bootstrap run. */
export const ANSWERS_FILE = 'mvpfy-answers.md';
/** The triage agent writes its plain-language diagnosis + fix summary here. */
export const TRIAGE_FILE = 'mvpfy-triage.md';
/** Plain-language summary of what bootstrap set up, written for the PM. */
export const SUMMARY_FILE = 'mvpfy-summary.md';
/** The instruct agent's report: what it changed and whether to restart. */
export const CHANGE_FILE = 'mvpfy-change.md';

export interface UpdateStatus {
  kind: 'available' | 'downloaded' | 'error';
  version?: string;
}

/** Where users can always fetch the newest build by hand. */
export const RELEASES_URL = 'https://github.com/feature1-ai/mvpfy.ai/releases/latest';

/** API surface exposed to the renderer through the preload contextBridge. */
export interface MvpfyApi {
  cliCheck(): Promise<CliStatus[]>;
  readState(): Promise<MvpfyState>;
  writeState(state: MvpfyState): Promise<void>;
  keychainGet(entry: string): Promise<string | null>;
  keychainSet(entry: string, value: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  createProject(repoUrls: string[]): Promise<CreateProjectResult>;
  pickDirectory(): Promise<string | null>;
  deleteProject(workspacePath: string): Promise<{ ok: boolean; error?: string }>;
  runAgent(req: RunAgentRequest): Promise<void>;
  stopRun(runId: string): Promise<void>;
  dockerCompose(runId: string, repoPath: string, action: 'up' | 'down' | 'restart'): Promise<void>;
  ide(runId: string, workspacePath: string, action: 'up' | 'down', port?: number): Promise<void>;
  cliLogin(runId: string, tool: 'gh' | 'codex'): Promise<void>;
  readRepoFiles(repoPath: string, relativePaths: string[]): Promise<RepoFile[]>;
  writeRepoFile(repoPath: string, relativePath: string, content: string): Promise<void>;
  repoBranches(dirs: string[]): Promise<Record<string, string>>;
  findFreePort(start: number): Promise<number>;
  probeUrl(url: string): Promise<{ reachable: boolean; status: number }>;
  mcpFetch(req: McpFetchRequest): Promise<McpFetchResponse>;
  onRunOutput(cb: (ev: RunOutputEvent) => void): () => void;
  onRunExit(cb: (ev: RunExitEvent) => void): () => void;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  installUpdate(): Promise<void>;
}
