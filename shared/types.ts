// Types shared between the Electron main process and the renderer.

export type AgentKind = 'claude' | 'codex';

/**
 * 'queued' is the state a freshly added project starts in: adding it is the
 * consent to set it up, so its view bootstraps it automatically on open.
 */
export type ProjectStatus =
  'queued' | 'cloned' | 'bootstrapping' | 'needs-review' | 'running' | 'stopped' | 'error';

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
  /** Slugs of planned features (one plan/spec file pair per slug). */
  planSlugs?: string[];
  /**
   * The PM has seen the app running with its demo login and accepted the
   * setup — the human gate on the last bootstrap card. Kept in mvpfy's own
   * state, never in the agent-written flow file, so no run can fake it.
   */
  bootstrapAccepted?: boolean;
  /**
   * Ids of launch-readiness findings the builder has decided to go live with
   * anyway. Kept here rather than in the agent's report so a re-run cannot
   * lose the decision — and so nothing but a person can make it.
   */
  readinessAccepted?: string[];
  /**
   * 'managed' (default): a clone under ~/.mvpfy/projects, fully owned by
   * mvpfy. 'linked': the user's own folder used in place — mvpfy keeps all
   * its files inside a .mvpfy/ subfolder and never deletes the folder.
   */
  mode?: 'managed' | 'linked';
}

/** Where mvpfy's generated/communication files live inside a workspace. */
export function configDirFor(mode: Project['mode']): string {
  return mode === 'linked' ? '.mvpfy/' : '';
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

/** How mvpfy would install one required tool on this machine. */
export interface InstallPlan {
  /** CLI name, or 'brew' for the prerequisite itself. */
  tool: string;
  label: string;
  /** The exact command, shown to the user before it runs. */
  command: string;
  /** 'terminal' means it needs a password or its own window: mvpfy hands it
   *  to Terminal.app rather than pretending it can answer a sudo prompt. */
  mode: 'in-app' | 'terminal';
  /** One line telling the user what to expect. */
  note: string;
  /** False when a prerequisite is missing, or there is no installer here. */
  available: boolean;
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
/** The bootstrap run's own task board: what setup is doing, card by card. */
export const BOOTSTRAP_FILE = 'mvpfy-bootstrap.json';
/** Launch readiness: what stands between the prototype and real users. */
export const READINESS_FILE = 'mvpfy-readiness.json';
/** Machine-readable product plan: spec items + stories + board lanes. */
export const PLAN_FILE = 'mvpfy-plan.json';
/** Human-readable product spec generated alongside the plan. */
export const SPEC_FILE = 'mvpfy-spec.md';

/**
 * A project can hold one plan per feature, each in its own file pair so
 * planning one feature never touches another's board. The empty slug is
 * the legacy single-plan pair from before multi-feature planning.
 */
export function planFileFor(slug: string): string {
  return slug ? `mvpfy-plan.${slug}.json` : PLAN_FILE;
}
export function specFileFor(slug: string): string {
  return slug ? `mvpfy-spec.${slug}.md` : SPEC_FILE;
}

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
  createProject(repoUrls: string[], link?: boolean): Promise<CreateProjectResult>;
  pickDirectory(): Promise<string | null>;
  deleteProject(workspacePath: string): Promise<{ ok: boolean; error?: string }>;
  runAgent(req: RunAgentRequest): Promise<void>;
  stopRun(runId: string): Promise<void>;
  dockerCompose(
    runId: string,
    repoPath: string,
    action: 'up' | 'down' | 'restart' | 'logs'
  ): Promise<void>;
  ide(runId: string, workspacePath: string, action: 'up' | 'down', port?: number): Promise<void>;
  /** Live IDE-container state from docker (stored idePort can go stale). */
  ideStatus(workspacePath: string): Promise<{ running: boolean; port: number | null }>;
  cliLogin(runId: string, tool: string): Promise<void>;
  /** How each required tool would be installed on this machine (macOS only). */
  installPlans(): Promise<InstallPlan[]>;
  /** Install one required tool, streaming its output like any other run. */
  installTool(runId: string, tool: string): Promise<void>;
  readRepoFiles(repoPath: string, relativePaths: string[]): Promise<RepoFile[]>;
  writeRepoFile(repoPath: string, relativePath: string, content: string): Promise<void>;
  repoBranches(dirs: string[]): Promise<Record<string, string>>;
  repoSync(runId: string, workspacePath: string, dirs: string[]): Promise<void>;
  findFreePort(start: number): Promise<number>;
  probeUrl(url: string): Promise<{ reachable: boolean; status: number }>;
  mcpFetch(req: McpFetchRequest): Promise<McpFetchResponse>;
  onRunOutput(cb: (ev: RunOutputEvent) => void): () => void;
  onRunExit(cb: (ev: RunExitEvent) => void): () => void;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  installUpdate(): Promise<void>;
}
