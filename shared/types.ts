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
   * The feature whose code the workspace is currently checked out on, so the
   * app that is running is that feature's. Only one at a time — there is one
   * working copy, which is the whole reason implementation happens elsewhere.
   */
  testingSlug?: string | null;
  /**
   * One Claude conversation per feature, by plan slug. Planning, refining and
   * implementing a feature all continue it, so refining a spec knows why the
   * spec says what it does. Kept here rather than in the agent-written plan
   * file, which the agent would be rewriting underneath us.
   */
  featureSessions?: Record<string, string>;
  /**
   * What the product manager actually typed to ask for each feature, by plan
   * slug. The spec that comes back is the agent's reading of it; this is the
   * request itself, which is what belongs in a description when the feature is
   * filed in Feature1. Kept here rather than in the plan file, which the agent
   * rewrites on every refinement.
   */
  featureAsks?: Record<string, string>;
  /**
   * The Feature1 feature each board was pulled from, by plan slug, recorded
   * the moment a pull starts.
   *
   * The plan file carries the same reference, but only once the run has
   * finished writing it — minutes later. Until then nothing knew the feature
   * was already being pulled, so it stayed on offer and every click started
   * another board for it.
   */
  feature1Refs?: Record<string, string>;
  /**
   * 'managed' (default): a clone under ~/.mvpfy/projects, fully owned by
   * mvpfy. 'linked': the user's own folder used in place — mvpfy keeps all
   * its files inside a .mvpfy/ subfolder and never deletes the folder.
   */
  mode?: 'managed' | 'linked';
  /**
   * The hostname the app expects to be asked for, when it resolves a tenant
   * from one. A share otherwise arrives as the tunnel's random name, which
   * matches no tenant, and the visitor is shown nothing.
   */
  shareHostHeader?: string;
}

/** Where mvpfy's generated/communication files live inside a workspace. */
export function configDirFor(mode: Project['mode']): string {
  return mode === 'linked' ? '.mvpfy/' : '';
}

/**
 * Compose lifecycle actions. 'force-down' is the escape hatch for a stack
 * that will not stop politely: it SIGKILLs rather than waiting out the
 * shutdown grace period.
 */
export type ComposeAction = 'up' | 'down' | 'restart' | 'rebuild' | 'force-down' | 'logs';

export interface TenantConfig {
  slug: string;
  host: string;
  tokenKeychainEntry: string;
}

export interface Settings {
  defaultAgent: AgentKind;
  /**
   * Model for Codex runs. Empty means "whatever `codex` is configured to use",
   * for the same reason claudeModel works that way — and for one more: naming
   * a model here made every Codex run fail for anyone signed in with a ChatGPT
   * account, which rejects the model outright. A default that depends on which
   * kind of account someone has is not a default.
   */
  codexModel: string;
  /**
   * Model for Claude Code runs. Empty means "whatever `claude` is configured
   * to use" — the safe default, since it respects the user's own setup and
   * cannot break when the set of available models changes.
   */
  claudeModel: string;
  /**
   * What to build with when a project's workspace is empty.
   *
   * mvpfy has always read the product to know how to extend it, which leaves
   * it with nothing to read on a repository that has no product yet. Rather
   * than ask a product manager to choose a stack — the sort of question this
   * app exists to spare them — it picks, and a technical user can change it
   * here before the first story is implemented. Empty falls back to
   * DEFAULT_STACK; it never means "let the agent decide", because two projects
   * from the same person would then diverge for no visible reason.
   */
  defaultStack: string;
}

/**
 * Deliberately ordinary, and deliberately close to what the bootstrap step
 * already knows how to run: compose brings it up, a seed script fills it, and
 * both halves reload in place while a story is being tested.
 */
export const DEFAULT_STACK =
  'React + Vite + TypeScript (Tailwind) on the front end, Node + Express + TypeScript on the ' +
  'back end, PostgreSQL for data, all wired together with Docker Compose';

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
    codexModel: '',
    claudeModel: '',
    defaultStack: '',
  },
};

/**
 * The Codex model mvpfy used to pick for everyone. A ChatGPT account refuses
 * it, so every run failed at the first request. Nobody chose it — it was the
 * default — so it is cleared on load rather than left to be found in Settings.
 */
export const RETIRED_CODEX_MODEL = 'gpt-5.3-codex';

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

/**
 * Where a brand-new project pushes to.
 *
 * 'existing' is for the repository somebody has already made and not yet put
 * anything in — the usual way a project starts, and the case that previously
 * forced a choice between a second repository nobody wanted and no remote at
 * all. 'none' is fine too: everything but raising a pull request works without
 * one, and one can be added later.
 */
export type BlankProjectRemote =
  { kind: 'create' } | { kind: 'existing'; url: string } | { kind: 'none' };

/**
 * What a feature's checkout of one repository is actually holding.
 *
 * Raising a pull request counts commits, so work an agent left uncommitted is
 * invisible to it: the feature reports "nothing to raise" with the changes
 * sitting on disk a folder away. This is what makes that legible, and it reads
 * the repository rather than trusting any run's account of what it did.
 */
export interface FeatureRepoGit {
  /** Repository directory in the workspace. */
  repo: string;
  /** Its checkout for this feature, empty when there is none yet. */
  worktree: string;
  /** Paths changed but not committed, as `git status --porcelain` reports. */
  uncommitted: string[];
  /** Commits on the branch that the trunk does not have — the pull request. */
  ahead: number;
  /** Commits the trunk has that the branch has not — what updating brings in. */
  behind: number;
  /** The trunk it was measured against: origin/main, or main with no remote. */
  trunk: string;
  /** Commits the remote has not got. -1 when the branch was never pushed. */
  unpushed: number;
  /** A merge was started and never finished — the next run would fail on it. */
  mergeInProgress: boolean;
}

/**
 * A feature checkout with a merge left open in it.
 *
 * `files` is what git still calls unmerged; an empty list with the merge still
 * open is the other half of the same state — resolved, not yet committed.
 */
export interface MergeConflicts {
  /** Repository directory in the workspace. */
  repo: string;
  /** The feature's checkout, where the merge is open. */
  worktree: string;
  /** Paths git still reports as unmerged. */
  files: string[];
}

/**
 * What GitHub says about one pull request mvpfy raised.
 *
 * The board records that a pull request was opened and then stops knowing
 * anything: whether it merged, whether its checks went red, whether somebody
 * asked for changes. That is the half of shipping that happens after mvpfy's
 * part is done, and it is the half a product manager most wants to see.
 */
export interface PullRequestState {
  url: string;
  number: number;
  title: string;
  /** OPEN, MERGED or CLOSED. Empty when GitHub could not be asked. */
  state: string;
  isDraft: boolean;
  /** Rolled up from every check: passing | failing | pending | none. */
  checks: 'passing' | 'failing' | 'pending' | 'none';
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty for none. */
  reviewDecision: string;
  /** Why the answer is missing, when it is. */
  error?: string;
}

/**
 * What a feature was left holding when a run stopped part-way.
 *
 * The three ways it can happen look different inside and identical outside:
 * something was being built, it stopped, the work is still there. So they are
 * one shape, answered by one button.
 */
export interface StrandedFeature {
  /** The story left in Coding, if the run that stopped was building one. */
  story: string | null;
  /** Files changed and never committed, across the feature's checkouts. */
  files: number;
  /** The run stopped because the agent's allowance ran out, not from a fault. */
  quota: boolean;
}

export interface CreateProjectResult {
  ok: boolean;
  slug: string;
  workspacePath: string;
  repos: RepoCloneOutcome[];
  error?: string;
}

/**
 * Feature1 MCP server to register with the spawned coding agent for this
 * run, so a ship-feature prompt's mcp__feature1__* tool calls resolve. The
 * agent is started with a per-run MCP config carrying these — nothing is
 * written into the repo or the user's global agent config.
 */
export interface RunAgentMcp {
  /** e.g. https://<slug>-mcp.feature1.ai/mcp/ */
  url: string;
  /**
   * Personal bearer token. Feature1 agent runs reject missing credentials;
   * optional here only for compatibility with older IPC callers.
   */
  token?: string;
}

/**
 * The conversation a run continues. mvpfy mints the id, so it never has to
 * read one back out of the agent's output to know what to resume.
 *
 * Claude Code only: codex can resume a session but cannot be told which id to
 * use for a new one, so there is nothing to hand it up front.
 */
export interface RunSession {
  id: string;
  /** False on the run that opens the conversation, true on every one after. */
  resume: boolean;
}

export interface RunAgentRequest {
  /** Unique id used to correlate streamed output events. */
  runId: string;
  agent: AgentKind;
  repoPath: string;
  promptText: string;
  /** Model to run. Omitted means the agent's own configured default. */
  model?: string;
  /** When set, the Feature1 MCP server is registered with the agent. */
  mcp?: RunAgentMcp;
  /** When set, the run opens or continues a named conversation. */
  session?: RunSession;
  /**
   * Images the agent should look at — a feature's design. Codex takes these as
   * --image arguments; Claude Code opens them from the paths in the prompt,
   * which the prompt carries either way.
   */
  images?: string[];
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
/** What putting this product online would create, and what it would cost. */
export const LAUNCH_FILE = 'mvpfy-launch.json';
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

/**
 * Where a feature's design files live, inside the workspace so the agent can
 * open them by path the way it opens anything else.
 */
export function designDirFor(slug: string): string {
  return `mvpfy-design/${slug || 'feature'}`;
}

/** Image files a design can be attached as. */
export const DESIGN_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** One service of a project's stack, as docker reports it. */
export interface ServiceState {
  service: string;
  state: string;
  exitCode: number | null;
  /**
   * The container's own healthcheck, when its image or the compose file
   * defines one: 'healthy' | 'unhealthy' | 'starting'. Empty when there is
   * none — which is not a problem, only less to go on.
   */
  health?: string;
}

/**
 * Whether the stack is getting anywhere, asked of docker rather than of a
 * clock. `logSignature` is the tail of the combined logs: while it keeps
 * changing the app is doing something, however slowly, and a slow machine is
 * therefore not mistaken for a stuck one.
 */
export interface ComposeProgress {
  services: ServiceState[];
  logSignature: string;
}

export interface UpdateStatus {
  /**
   * 'none' and 'unsupported' only ever answer a check the user asked for —
   * nothing to say is not worth a banner. 'unsupported' is a dev build, which
   * has no release to update from.
   */
  kind: 'available' | 'downloaded' | 'error' | 'none' | 'unsupported';
  version?: string;
  /** Why a check failed, in whatever words the updater used. */
  message?: string;
}

/** Where users can always fetch the newest build by hand. */
export const RELEASES_URL = 'https://github.com/feature1-ai/mvpfy.ai/releases/latest';

/**
 * Direct link to a version's macOS installer.
 *
 * Windows and Linux update themselves; macOS cannot install an update it
 * cannot verify, and these builds are unsigned. Sending someone to a releases
 * page to find the right file among eleven is the worst of both — this at
 * least starts the download of the one they want.
 */
export function macInstallerUrl(version: string): string {
  return (
    'https://github.com/feature1-ai/mvpfy.ai/releases/download/' +
    `v${version}/mvpfy-by-feature1-${version}.dmg`
  );
}

/** API surface exposed to the renderer through the preload contextBridge. */
export interface MvpfyApi {
  /** The running build's version, for support and update checks. */
  appVersion(): Promise<string>;
  cliCheck(): Promise<CliStatus[]>;
  /** Model names this agent's CLI advertises; empty when it will not say. */
  agentModels(agent: AgentKind): Promise<string[]>;
  readState(): Promise<MvpfyState>;
  writeState(state: MvpfyState): Promise<void>;
  keychainGet(entry: string): Promise<string | null>;
  keychainSet(entry: string, value: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  createProject(repoUrls: string[], link?: boolean): Promise<CreateProjectResult>;
  /** True when no repository in the workspace holds a product yet. */
  workspaceEmpty(dirs: string[]): Promise<boolean>;
  /**
   * Start a product with no repository behind it yet. `remoteError` is set when
   * the workspace was made but GitHub was not — the project still works, and
   * only raising a pull request needs the remote.
   */
  createBlankProject(
    name: string,
    remote: BlankProjectRemote
  ): Promise<CreateProjectResult & { remoteError?: string }>;
  /** Chosen folders, in pick order. Empty when the dialog was cancelled. */
  pickDirectory(): Promise<string[]>;
  deleteProject(workspacePath: string): Promise<{ ok: boolean; error?: string }>;
  runAgent(req: RunAgentRequest): Promise<void>;
  stopRun(runId: string): Promise<void>;
  dockerCompose(runId: string, repoPath: string, action: ComposeAction): Promise<void>;
  ide(runId: string, workspacePath: string, action: 'up' | 'down', port?: number): Promise<void>;
  /**
   * Run the project's recorded seed command. Resolves false when it records
   * none, which is normal for a product that needs no seeding.
   */
  seed(runId: string, workspacePath: string): Promise<boolean>;
  /**
   * What each service of the stack is actually doing. `docker compose up -d`
   * succeeds once containers have started, so this is the only way to tell an
   * app that is still booting from one that started and died.
   */
  composeStatus(workspacePath: string): Promise<ServiceState[]>;
  /** Container states plus whether anything is still being logged. */
  composeProgress(workspacePath: string): Promise<ComposeProgress>;
  /** Live IDE-container state from docker (stored idePort can go stale). */
  ideStatus(workspacePath: string): Promise<{ running: boolean; port: number | null }>;
  cliLogin(runId: string, tool: string): Promise<void>;
  /** How each required tool would be installed on this machine (macOS only). */
  /** Add an MCP server to the selected agent, at user scope. */
  registerMcpServer(runId: string, name: string, url: string, agent: AgentKind): Promise<void>;
  /** Open the user's own terminal in a project, for talking to the agent directly. */
  openTerminal(workspacePath: string): Promise<void>;
  installPlans(): Promise<InstallPlan[]>;
  /** Install every missing tool that needs no password, in one run. */
  installAll(runId: string, tools: string[]): Promise<void>;
  /** Sign in to several tools, one after another, in one run. */
  signInAll(runId: string, tools: string[]): Promise<void>;
  /** What each repository's checkout of this feature is holding. */
  featureGitStatus(
    workspacePath: string,
    dirs: string[],
    projectKey: string,
    featureSlug: string,
    branch: string
  ): Promise<FeatureRepoGit[]>;
  /** Commit whatever is uncommitted in a feature's checkouts. */
  commitFeatureWork(
    runId: string,
    workspacePath: string,
    dirs: string[],
    projectKey: string,
    featureSlug: string,
    branch: string,
    message: string
  ): Promise<void>;
  /** What is still conflicted in a feature's checkouts, read from git. */
  featureConflicts(
    workspacePath: string,
    dirs: string[],
    projectKey: string,
    featureSlug: string
  ): Promise<MergeConflicts[]>;
  /** Commit a resolved merge, or abandon it and leave the feature as it was. */
  finishMerge(
    runId: string,
    workspacePath: string,
    dirs: string[],
    projectKey: string,
    featureSlug: string,
    branch: string,
    mode: 'commit' | 'abort'
  ): Promise<void>;
  /** Push a feature's branch where the remote already has it, after an update. */
  pushFeatureBranch(
    runId: string,
    workspacePath: string,
    dirs: string[],
    branch: string
  ): Promise<void>;
  /** Merge the trunk into a feature's branch, in its worktree. */
  mergeTrunk(
    runId: string,
    workspacePath: string,
    dirs: string[],
    projectKey: string,
    featureSlug: string,
    branch: string,
    onConflict: 'abort' | 'keep'
  ): Promise<void>;
  /** Hand what is still missing to the coding agent to finish. */
  installToolsAgent(req: RunAgentRequest): Promise<void>;
  /** Install one required tool, streaming its output like any other run. */
  installTool(runId: string, tool: string): Promise<void>;
  readRepoFiles(repoPath: string, relativePaths: string[]): Promise<RepoFile[]>;
  writeRepoFile(repoPath: string, relativePath: string, content: string): Promise<void>;
  repoBranches(dirs: string[]): Promise<Record<string, string>>;
  /** Chosen image files, in pick order. Empty when cancelled. */
  pickImages(): Promise<string[]>;
  /** Copy designs into the feature's folder; returns the recorded names. */
  addDesign(
    workspacePath: string,
    configDir: string,
    slug: string,
    sources: string[]
  ): Promise<string[]>;
  removeDesign(workspacePath: string, configDir: string, slug: string, name: string): Promise<void>;
  /** One design as a data URL, or null when it is missing or too large. */
  readDesign(
    workspacePath: string,
    configDir: string,
    slug: string,
    name: string
  ): Promise<string | null>;
  /** Absolute paths of a feature's designs, for handing to an agent. */
  designPaths(
    workspacePath: string,
    configDir: string,
    slug: string,
    names: string[]
  ): Promise<string[]>;
  /** True when the tunnel client is installed. */
  canShare(): Promise<boolean>;
  /**
   * Put a locally-running app on the internet until the run is stopped.
   * `hostHeader` is what the local app should be told it was asked for, for a
   * product that resolves a tenant from the hostname.
   */
  startShare(
    runId: string,
    workspacePath: string,
    port: number,
    hostHeader?: string
  ): Promise<void>;
  /** Remove a feature's plan, spec and designs. Never its branch. */
  deleteFeature(
    workspacePath: string,
    configDir: string,
    slug: string
  ): Promise<{ removed: string[] }>;
  /** What GitHub says about each pull request raised for a feature. */
  pullRequestStates(urls: string[]): Promise<PullRequestState[]>;
  /** The remote each repo actually points at; empty string when it has none. */
  repoRemotes(dirs: string[]): Promise<Record<string, string>>;
  /** Point a repo at a remote and push what it has. */
  addRemote(runId: string, workspacePath: string, dir: string, url: string): Promise<void>;
  /** Push a feature branch and open a pull request in each repo that changed. */
  raisePullRequests(
    runId: string,
    workspacePath: string,
    dirs: string[],
    branch: string,
    title: string,
    body: string
  ): Promise<void>;
  /**
   * Add or remove a feature's per-repository checkouts. Resolves with where
   * they are, so the caller can tell an agent where to work.
   */
  worktree(
    workspacePath: string,
    dirs: string[],
    projectKey: string,
    featureSlug: string,
    branch: string,
    action: 'add' | 'remove'
  ): Promise<{ ok: boolean; paths?: Record<string, string>; error?: string }>;
  /** True when the workspace is on this feature's latest commit, not an older one. */
  featureCheckedOut(dirs: string[], branch: string): Promise<boolean>;
  /** Put the workspace on a feature's branch for testing, or null for trunk. */
  checkoutFeature(
    workspacePath: string,
    dirs: string[],
    branch: string | null
  ): Promise<{ ok: boolean; error?: string }>;
  repoSync(runId: string, workspacePath: string, dirs: string[]): Promise<void>;
  findFreePort(start: number): Promise<number>;
  probeUrl(url: string): Promise<{ reachable: boolean; status: number }>;
  mcpFetch(req: McpFetchRequest): Promise<McpFetchResponse>;
  onRunOutput(cb: (ev: RunOutputEvent) => void): () => void;
  onRunExit(cb: (ev: RunExitEvent) => void): () => void;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  /**
   * Ask now rather than waiting for the check at launch. Resolves once the
   * updater has an answer, so the caller can show one.
   */
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
}
