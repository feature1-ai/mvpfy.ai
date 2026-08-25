import { useCallback, useEffect, useState } from 'react';
import {
  ANSWERS_FILE,
  CHANGE_FILE,
  SUMMARY_FILE,
  TRIAGE_FILE,
  GENERATED_FILES,
  MvpfyState,
  Project,
  QUESTIONS_FILE,
  RepoFile,
  configDirFor,
  planFileFor,
  specFileFor,
} from '../../shared/types';
import { DemoCredential, parseDemoCredentials } from '../lib/credentials';
import { parseAppPort } from '../lib/ports';
import { UserStory } from '../lib/feature1Mcp';
import { ENV_FILE_CANDIDATES } from '../lib/envFile';
import { StoryLane } from '../lib/plan';
import { MobilePreview, parseMobilePreview } from '../lib/mobile';
import { RunsApi, RunState } from '../lib/useRuns';
import { ControllerContext, contentOf, UpdateState } from './controllerContext';
import { useAgentActions } from './useAgentActions';
import { FeaturePlan, usePlanActions } from './usePlanActions';
import { useProjectActions } from './useProjectActions';

export type { UpdateState } from './controllerContext';
export type { FeaturePlan } from './usePlanActions';

/** Agent-communication files shown in dedicated cards, not the file viewer. */
const HIDDEN_FROM_VIEWER: string[] = [
  QUESTIONS_FILE,
  TRIAGE_FILE,
  SUMMARY_FILE,
  CHANGE_FILE,
  ...ENV_FILE_CANDIDATES,
];

/** Strip the linked-mode config-dir prefix to compare bare file names. */
function baseName(name: string): string {
  return name.startsWith('.mvpfy/') ? name.slice('.mvpfy/'.length) : name;
}

function hiddenFromViewer(name: string): boolean {
  const base = baseName(name);
  return HIDDEN_FROM_VIEWER.includes(base) || /^mvpfy-(plan|spec)($|\.)/.test(base);
}

/**
 * Controller for a project's detail view: owns all project actions, file and
 * health polling, and derived view state. Components stay presentational.
 */
export interface ProjectController {
  project: Project;
  // Derived view state
  appUrl: string;
  appHealthy: boolean;
  ideUrl: string | null;
  ideHealthy: boolean;
  ideStarting: boolean;
  busy: boolean;
  latestRun: RunState | null;
  /** The follow-mode docker logs stream, when one has been started. */
  appLogsRun: RunState | null;
  startAppLogs(): Promise<boolean>;
  /** Pull the latest changes from each repo's remote into the clone. */
  syncRepos(): Promise<boolean>;
  lastShipPrUrl: string | null;
  actionError: string | null;
  hasMvpfyYml: boolean;
  demoCredentials: DemoCredential[];
  mobilePreview: MobilePreview | null;
  questionsFile: RepoFile | null;
  /** Plain-language triage result (diagnosis + fix) from a Diagnose & fix run. */
  triageContent: string | null;
  /** Plain-language bootstrap summary the PM reads instead of the Dockerfile. */
  summaryContent: string | null;
  /** True when the last environment run failed and can be diagnosed. */
  canDiagnose: boolean;
  viewerFiles: RepoFile[];
  activeFile: string | null;
  activeFileContent: string;
  stories: UserStory[];
  storiesError: string | null;
  loadingStories: boolean;
  tenantConnected: boolean;
  answersDraft: string;
  targetRepoDir: string;
  removing: boolean;
  confirmRemove: boolean;
  // Actions
  bootstrap(): Promise<boolean>;
  saveAnswersAndRerun(): Promise<boolean>;
  docker(action: 'up' | 'down' | 'restart'): Promise<boolean>;
  /** Feed the failed run's log to the agent: plain-language diagnosis + fix. */
  diagnose(): Promise<boolean>;
  /** Re-run the step the triage file says to retry. */
  retryFix(): Promise<boolean>;
  dismissTriage(): Promise<boolean>;
  /** Free-form PM instruction ("add env var X…") applied by the agent. */
  instruct(instruction: string): Promise<boolean>;
  dismissChange(): Promise<boolean>;
  /** Commit + push the workspace's product changes and open PR(s). */
  shipChange(): Promise<boolean>;
  /** True when the last change report says the environment must restart. */
  changeNeedsRestart: boolean;
  changeContent: string | null;
  /** The env file the editor works on: first existing candidate, or null. */
  envFile: { name: string; content: string } | null;
  /** Content of .env.mvpfy.example when present (seed for a new env file). */
  envExample: string | null;
  saveEnv(name: string, content: string): Promise<boolean>;
  /** All planned features (one board each), legacy single plan included. */
  plans: FeaturePlan[];
  /** The feature whose board the Plan tab is showing. */
  activePlan: FeaturePlan | null;
  setActivePlanSlug(slug: string): void;
  /** True while any feature's story is being implemented (one at a time). */
  anyStoryRunning: boolean;
  /** True when a run that mutates the workspace blocks starting a story. */
  planBlocked: boolean;
  /** Resolves true when the run actually started (false on a guard error). */
  generateSpec(description: string): Promise<boolean>;
  refineSpec(instruction: string): Promise<boolean>;
  /** PM agrees with the PRD — reveals the active feature's story board. */
  approvePlan(): Promise<boolean>;
  implementStory(code: string): Promise<boolean>;
  moveStory(code: string, lane: StoryLane, feedback?: string): Promise<boolean>;
  refreshStories(): Promise<boolean>;
  implement(story: UserStory): Promise<boolean>;
  startIde(): Promise<boolean>;
  stopIde(): Promise<boolean>;
  removeProject(): Promise<boolean>;
  refreshFiles(): void;
  stopRun(runId: string): void;
  setActiveFile(file: string): void;
  setAnswersDraft(text: string): void;
  setTargetRepoDir(dir: string): void;
  setConfirmRemove(value: boolean): void;
  openExternal(url: string): void;
}

/**
 * Thin composer: owns file loading, health polling, and derived view state,
 * and delegates the actions to the per-resource hooks (useProjectActions,
 * usePlanActions, useAgentActions) via a shared ControllerContext.
 */
export function useProjectController(
  project: Project,
  state: MvpfyState,
  updateState: UpdateState,
  runsApi: RunsApi
): ProjectController {
  const [files, setFiles] = useState<RepoFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [appHealthy, setAppHealthy] = useState(false);
  const [ideHealthy, setIdeHealthy] = useState(false);

  const projectRuns = Object.values(runsApi.runs).filter((r) => r.handle.projectId === project.id);
  // The follow-mode app-logs stream never counts as activity: it runs for
  // as long as the tab wants it and must not block buttons or the strip.
  const latestRun = projectRuns.filter((r) => r.handle.kind !== 'app-logs').pop() ?? null;
  const appLogsRun = projectRuns.filter((r) => r.handle.kind === 'app-logs').pop() ?? null;
  const busy = latestRun?.running ?? false;
  const lastShipRun = Object.values(runsApi.runs)
    .filter((r) => r.handle.projectId === project.id && r.handle.kind === 'ship')
    .pop();

  // Linked projects keep every mvpfy file inside .mvpfy/ — pf() maps a bare
  // name to where it actually lives for this project.
  const cfg = configDirFor(project.mode);
  const pf = useCallback((name: string) => cfg + name, [cfg]);

  const planSlugsKey = (project.planSlugs ?? []).join(',');
  const refreshFiles = useCallback(() => {
    const planSlugs = ['', ...(planSlugsKey ? planSlugsKey.split(',') : [])];
    void window.mvpfy
      .readRepoFiles(project.localPath, [
        ...[
          ...GENERATED_FILES,
          QUESTIONS_FILE,
          ANSWERS_FILE,
          TRIAGE_FILE,
          SUMMARY_FILE,
          CHANGE_FILE,
          ...planSlugs.flatMap((slug) => [planFileFor(slug), specFileFor(slug)]),
          ...ENV_FILE_CANDIDATES,
        ].map(pf),
      ])
      .then((result) => {
        setFiles(result);
        const viewable = result
          .filter((f) => f.exists && !hiddenFromViewer(f.relativePath))
          .map((f) => f.relativePath);
        setActiveFile((prev) => (prev && viewable.includes(prev) ? prev : (viewable[0] ?? null)));
        const generated = result
          .filter(
            (f) =>
              f.exists && (GENERATED_FILES as readonly string[]).includes(baseName(f.relativePath))
          )
          .map((f) => f.relativePath);
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, generatedFiles: generated } : p
          ),
        }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.localPath, planSlugsKey]);

  // Load files on mount and again whenever a run for this project starts or
  // finishes — with concurrent runs, "all quiet" is too rare a moment to wait
  // for (a spec can finish while a story is still coding).
  const runningCount = projectRuns.filter((r) => r.running).length;
  useEffect(() => {
    refreshFiles();
  }, [runningCount, refreshFiles]);

  // The last finished environment run (bootstrap or start) decides whether
  // Diagnose & fix applies — derived, so a later success clears it naturally.
  const lastEnvRun = Object.values(runsApi.runs)
    .filter(
      (r) =>
        r.handle.projectId === project.id &&
        !r.running &&
        (r.handle.kind === 'bootstrap' || r.handle.kind === 'docker-up')
    )
    .pop();
  const lastFailure =
    lastEnvRun && lastEnvRun.exitCode !== 0
      ? (lastEnvRun.handle.kind as 'bootstrap' | 'docker-up')
      : null;

  const hasMvpfyYml = files.some((f) => f.relativePath === pf('mvpfy.yml') && f.exists);
  const mvpfyYmlContent = files.find((f) => f.relativePath === pf('mvpfy.yml'))?.content;

  // mvpfy.yml is the source of truth for where the app actually runs — the
  // agent may have had to shift off the assigned port at build time. Follow
  // the file, and reconcile stored state so every label shows the real port.
  const appPort = parseAppPort(mvpfyYmlContent) ?? project.basePort;
  useEffect(() => {
    if (appPort === project.basePort) return;
    updateState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === project.id ? { ...p, basePort: appPort } : p)),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPort, project.basePort, project.id]);

  // Poll a local port until it answers HTTP so the PM can see when the app
  // (or IDE) is actually ready, not just when its process started.
  useHealthPoll(project.status === 'running' ? appPort : null, setAppHealthy, appHealthy);
  const idePort = project.idePort ?? null;
  useHealthPoll(idePort, setIdeHealthy, ideHealthy);

  // Reconcile the stored IDE port against docker: containers die on reboot,
  // and a stale port that some OTHER project's code-server later binds would
  // otherwise embed the wrong project's editor in the Code tab.
  useEffect(() => {
    void window.mvpfy.ideStatus(project.localPath).then((s) => {
      const actual = s.running ? (s.port ?? project.idePort ?? null) : null;
      if ((project.idePort ?? null) === actual) return;
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => (p.id === project.id ? { ...p, idePort: actual } : p)),
      }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningCount, project.id, project.localPath, project.idePort]);

  async function guarded(action: () => Promise<void>): Promise<boolean> {
    setActionError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  const ctx: ControllerContext = {
    project,
    state,
    updateState,
    runsApi,
    projectRuns,
    pf,
    files,
    refreshFiles,
    guarded,
  };
  const projectActions = useProjectActions(ctx, lastFailure, latestRun, appLogsRun);
  const planActions = usePlanActions(ctx);
  const agentActions = useAgentActions(ctx);

  return {
    ...projectActions,
    ...planActions,
    ...agentActions,
    project,
    appUrl: `http://localhost:${appPort}`,
    appHealthy,
    ideUrl: idePort ? `http://localhost:${idePort}` : null,
    ideHealthy,
    ideStarting: latestRun?.running === true && latestRun.handle.kind === 'ide-up',
    busy,
    latestRun,
    appLogsRun,
    lastShipPrUrl: lastShipRun?.prUrl ?? null,
    actionError,
    hasMvpfyYml,
    demoCredentials: parseDemoCredentials(mvpfyYmlContent),
    mobilePreview: parseMobilePreview(mvpfyYmlContent),
    questionsFile: files.find((f) => f.relativePath === pf(QUESTIONS_FILE) && f.exists) ?? null,
    triageContent: contentOf(files, pf(TRIAGE_FILE)),
    summaryContent: contentOf(files, pf(SUMMARY_FILE)),
    changeContent: contentOf(files, pf(CHANGE_FILE)),
    changeNeedsRestart: /restart:\s*yes/i.test(contentOf(files, pf(CHANGE_FILE)) ?? ''),
    envFile: (() => {
      for (const name of ENV_FILE_CANDIDATES) {
        const f = files.find((x) => x.relativePath === pf(name) && x.exists);
        if (f) return { name: pf(name), content: f.content ?? '' };
      }
      return null;
    })(),
    envExample: contentOf(files, pf('.env.mvpfy.example')),
    canDiagnose: lastFailure !== null,
    viewerFiles: files.filter((f) => f.exists && !hiddenFromViewer(f.relativePath)),
    activeFile,
    activeFileContent: files.find((f) => f.relativePath === activeFile)?.content ?? '',
    tenantConnected: state.tenant !== null,
    refreshFiles,
    stopRun: runsApi.stop,
    setActiveFile,
    openExternal: (url: string) => void window.mvpfy.openExternal(url),
  };
}

/** Poll http://localhost:<port> until it responds; reset when port is null. */
function useHealthPoll(
  port: number | null,
  setHealthy: (v: boolean) => void,
  healthy: boolean
): void {
  useEffect(() => {
    if (!port) {
      setHealthy(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      const res = await window.mvpfy.probeUrl(`http://localhost:${port}`);
      if (!cancelled && res.reachable) setHealthy(true);
    };
    void check();
    const timer = setInterval(() => {
      if (!healthy) void check();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, healthy]);
}
