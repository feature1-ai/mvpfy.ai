import { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  startAppLogsRun,
  startBootstrapRun,
  startSyncRun,
  startDockerRun,
  startIdeRun,
  startInstructRun,
  startPlanSpecRun,
  startPlanStoryRun,
  startShipChangeRun,
  startShipFeatureRun,
  startTriageRun,
} from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import { DemoCredential, parseDemoCredentials } from '../lib/credentials';
import { parseAppPort } from '../lib/ports';
import { Feature1McpClient, UserStory } from '../lib/feature1Mcp';
import { ENV_FILE_CANDIDATES } from '../lib/envFile';
import {
  canMove,
  parsePlan,
  ProjectPlan,
  serializePlan,
  slugForFeature,
  StoryLane,
} from '../lib/plan';
import { MobilePreview, parseMobilePreview } from '../lib/mobile';
import { RunsApi, RunState } from '../lib/useRuns';

export type UpdateState = (mutate: (prev: MvpfyState) => MvpfyState) => void;

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

/** One planned feature: its parsed plan plus the live run state around it. */
export interface FeaturePlan {
  slug: string;
  plan: ProjectPlan | null;
  specMarkdown: string | null;
  /** True while the spec for this feature is being generated or refined. */
  generating: boolean;
  /** Story code this feature's agent is currently implementing, if any. */
  runningStory: string | null;
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

export function useProjectController(
  project: Project,
  state: MvpfyState,
  updateState: UpdateState,
  runsApi: RunsApi
): ProjectController {
  const [files, setFiles] = useState<RepoFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [stories, setStories] = useState<UserStory[]>([]);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [loadingStories, setLoadingStories] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answersDraft, setAnswersDraft] = useState('');
  const [appHealthy, setAppHealthy] = useState(false);
  const [ideHealthy, setIdeHealthy] = useState(false);
  const [targetRepoDir, setTargetRepoDir] = useState(project.repos[0]?.dir ?? project.localPath);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

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

  const bootstrap = () =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      // Re-verify the port right before generating: it is baked into the
      // compose file, so it must be genuinely free at bootstrap time.
      const freePort = await window.mvpfy.findFreePort(project.basePort);
      const target = { ...project, basePort: freePort };
      const handle = await startBootstrapRun(target, state.settings);
      runsApi.track(handle);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id ? { ...p, basePort: freePort, status: 'bootstrapping' } : p
        ),
      }));
    });

  const saveAnswersAndRerun = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, pf(ANSWERS_FILE), answersDraft);
      setAnswersDraft('');
      await bootstrap();
    });

  const docker = (action: 'up' | 'down' | 'restart') =>
    guarded(async () => {
      const handle = await startDockerRun(project, action);
      runsApi.track(handle);
    });

  const diagnose = () =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const failed = lastFailure ?? 'bootstrap';
      const failedRun = Object.values(runsApi.runs)
        .filter((r) => r.handle.projectId === project.id && r.handle.kind === failed)
        .pop();
      const logTail =
        failedRun && failedRun.log.trim()
          ? failedRun.log.slice(-4000)
          : '(log unavailable — the app was restarted after the failure or the run was ' +
            'interrupted; inspect the workspace to infer what happened)';
      const handle = await startTriageRun(
        project,
        state.settings,
        failed === 'docker-up' ? 'starting the environment (docker compose up)' : 'bootstrap',
        logTail
      );
      runsApi.track(handle);
    });

  const retryFix = () =>
    guarded(async () => {
      const wantsStart = /retry:\s*start/i.test(contentOf(files, pf(TRIAGE_FILE)) ?? '');
      await window.mvpfy.writeRepoFile(project.localPath, pf(TRIAGE_FILE), '');
      if (wantsStart || lastFailure === 'docker-up') {
        const handle = await startDockerRun(project, 'up');
        runsApi.track(handle);
      } else {
        await bootstrap();
      }
    });

  const dismissTriage = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, pf(TRIAGE_FILE), '');
      refreshFiles();
    });

  const instruct = (instruction: string) =>
    guarded(async () => {
      const text = instruction.trim();
      if (!text) return;
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      await window.mvpfy.writeRepoFile(project.localPath, pf(CHANGE_FILE), '');
      const handle = await startInstructRun(project, state.settings, text);
      runsApi.track(handle);
    });

  const dismissChange = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, pf(CHANGE_FILE), '');
      refreshFiles();
    });

  const shipChange = () =>
    guarded(async () => {
      // Shipping needs the agent AND gh (push + PR creation) signed in.
      const authProblem = await preflightAuth(state.settings.defaultAgent, true);
      if (authProblem) throw new Error(authProblem);
      const handle = await startShipChangeRun(project, state.settings);
      runsApi.track(handle);
    });

  const syncRepos = () =>
    guarded(async () => {
      const handle = await startSyncRun(project);
      runsApi.track(handle);
    });

  const startAppLogs = () =>
    guarded(async () => {
      if (appLogsRun?.running) return;
      const handle = await startAppLogsRun(project);
      runsApi.track(handle);
    });

  // One FeaturePlan per known slug; the empty slug is the legacy single plan.
  // A slug with no file yet still shows while its spec run is generating.
  const storyRuns = projectRuns.filter((r) => r.handle.kind === 'plan-story');
  const specRuns = projectRuns.filter((r) => r.handle.kind === 'plan-spec');
  const plans: FeaturePlan[] = ['', ...(project.planSlugs ?? [])]
    .map((slug): FeaturePlan => {
      const running = storyRuns.filter((r) => r.running && (r.handle.planSlug ?? '') === slug);
      return {
        slug,
        plan: parsePlan(contentOf(files, pf(planFileFor(slug)))),
        specMarkdown: contentOf(files, pf(specFileFor(slug))),
        generating: specRuns.some((r) => r.running && (r.handle.planSlug ?? '') === slug),
        runningStory: running.map((r) => r.handle.storyId ?? null).pop() ?? null,
      };
    })
    .filter((f) => f.plan !== null || f.generating);

  const [selectedPlanSlug, setSelectedPlanSlug] = useState<string | null>(null);
  const activePlan =
    plans.find((p) => p.slug === selectedPlanSlug) ?? (plans.length > 0 ? plans[0] : null);
  const anyStoryRunning = storyRuns.some((r) => r.running);
  // Runs that mutate repos or the environment: a story implementation must
  // not race them. Spec generation only writes its own plan/spec pair, so it
  // may overlap with anything — including stories of other features.
  const planBlocked = projectRuns.some(
    (r) => r.running && !['app-logs', 'plan-spec', 'plan-story'].includes(r.handle.kind)
  );
  const processedPlanRuns = useRef(new Set<string>());

  const writePlan = useCallback(
    async (slug: string, next: ProjectPlan) => {
      await window.mvpfy.writeRepoFile(
        project.localPath,
        pf(planFileFor(slug)),
        serializePlan(next)
      );
      refreshFiles();
    },
    [project.localPath, refreshFiles, pf]
  );

  // When a story run finishes cleanly, the agent's allowed move fires on its
  // feature's board: Coding → Testing, PR recorded, feedback consumed. Only
  // ever once per run, even with several features' runs finishing together.
  useEffect(() => {
    for (const run of storyRuns) {
      if (run.running || run.exitCode !== 0) continue;
      if (processedPlanRuns.current.has(run.handle.runId)) continue;
      const slug = run.handle.planSlug ?? '';
      const plan = plans.find((p) => p.slug === slug)?.plan;
      const code = run.handle.storyId;
      if (!plan || !code) continue;
      const story = plan.stories.find((s) => s.code === code);
      if (!story || story.lane !== 'coding' || !canMove('coding', 'testing', 'agent')) continue;
      processedPlanRuns.current.add(run.handle.runId);
      void writePlan(slug, {
        ...plan,
        stories: plan.stories.map((s) =>
          s.code === code
            ? { ...s, lane: 'testing' as StoryLane, prUrl: run.prUrl ?? s.prUrl, feedback: null }
            : s
        ),
      });
    }
  }, [storyRuns, plans, writePlan]);

  const generateSpec = (description: string) =>
    guarded(async () => {
      const text = description.trim();
      if (!text) return;
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const slug = slugForFeature(text, ['', ...(project.planSlugs ?? [])]);
      const handle = await startPlanSpecRun(project, state.settings, slug, text);
      runsApi.track(handle);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id ? { ...p, planSlugs: [...(p.planSlugs ?? []), slug] } : p
        ),
      }));
      setSelectedPlanSlug(slug);
    });

  const refineSpec = (instruction: string) =>
    guarded(async () => {
      const text = instruction.trim();
      if (!text || !activePlan) return;
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const handle = await startPlanSpecRun(
        project,
        state.settings,
        activePlan.slug,
        activePlan.plan?.spec.feature ?? text,
        text
      );
      runsApi.track(handle);
    });

  const approvePlan = () =>
    guarded(async () => {
      if (!activePlan?.plan) return;
      await writePlan(activePlan.slug, { ...activePlan.plan, approved: true });
    });

  const implementStory = (code: string) =>
    guarded(async () => {
      const slug = activePlan?.slug ?? '';
      const plan = activePlan?.plan;
      const story = plan?.stories.find((s) => s.code === code);
      if (!plan || !story) throw new Error(`Story ${code} not found in the plan`);
      if (!plan.approved) throw new Error('Agree with the PRD first — then the board opens');
      if (story.lane !== 'todo' && story.lane !== 'coding') {
        throw new Error(`${code} is in ${story.lane} — drag it back to To Do to re-implement`);
      }
      if (anyStoryRunning) {
        throw new Error(
          'A story is already being implemented — one at a time, so branches don’t collide'
        );
      }
      if (planBlocked) {
        throw new Error('Wait for the current environment run to finish first');
      }
      // Ship lands a PR at Testing, so the agent AND gh must be signed in.
      const authProblem = await preflightAuth(state.settings.defaultAgent, true);
      if (authProblem) throw new Error(authProblem);
      if (story.lane === 'todo') {
        await writePlan(slug, {
          ...plan,
          stories: plan.stories.map((s) =>
            s.code === code ? { ...s, lane: 'coding' as StoryLane } : s
          ),
        });
      }
      const handle = await startPlanStoryRun(project, state.settings, slug, code, story.feedback);
      runsApi.track(handle);
    });

  const moveStory = (code: string, lane: StoryLane, feedback?: string) =>
    guarded(async () => {
      const plan = activePlan?.plan;
      if (!plan || !activePlan) return;
      const story = plan.stories.find((s) => s.code === code);
      if (!story || !canMove(story.lane, lane, 'user')) return;
      const bounced = story.lane === 'testing' && lane === 'coding';
      await writePlan(activePlan.slug, {
        ...plan,
        stories: plan.stories.map((s) =>
          s.code === code
            ? {
                ...s,
                lane,
                feedback: bounced
                  ? feedback?.trim() || s.feedback
                  : lane === 'done'
                    ? null
                    : s.feedback,
              }
            : s
        ),
      });
    });

  const saveEnv = (name: string, content: string) =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, name, content);
      refreshFiles();
    });

  const refreshStories = () =>
    guarded(async () => {
      if (!state.tenant) {
        setStoriesError('Connect Feature1 in Settings first.');
        return;
      }
      setLoadingStories(true);
      setStoriesError(null);
      try {
        const token = await window.mvpfy.keychainGet(state.tenant.tokenKeychainEntry);
        const client = new Feature1McpClient(state.tenant.slug, token);
        setStories(await client.listUserStories());
      } catch (err) {
        setStoriesError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingStories(false);
      }
    });

  const implement = (story: UserStory) =>
    guarded(async () => {
      // Ship needs the agent AND gh (push + PR creation) to be signed in.
      const authProblem = await preflightAuth(state.settings.defaultAgent, true);
      if (authProblem) throw new Error(authProblem);
      const handle = await startShipFeatureRun(project, story.id, state.settings, targetRepoDir);
      runsApi.track(handle);
    });

  const startIde = () =>
    guarded(async () => {
      const port = await window.mvpfy.findFreePort(project.basePort + 500);
      const handle = await startIdeRun(project, 'up', port);
      runsApi.track(handle);
    });

  const stopIde = () =>
    guarded(async () => {
      const handle = await startIdeRun(project, 'down');
      runsApi.track(handle);
    });

  const removeProject = () =>
    guarded(async () => {
      setRemoving(true);
      try {
        if (latestRun?.running) runsApi.stop(latestRun.handle.runId);
        const res = await window.mvpfy.deleteProject(project.localPath);
        if (!res.ok) throw new Error(res.error || 'Failed to delete project files');
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.filter((p) => p.id !== project.id),
        }));
      } finally {
        setRemoving(false);
        setConfirmRemove(false);
      }
    });

  return {
    project,
    appUrl: `http://localhost:${appPort}`,
    appHealthy,
    ideUrl: idePort ? `http://localhost:${idePort}` : null,
    ideHealthy,
    ideStarting: latestRun?.running === true && latestRun.handle.kind === 'ide-up',
    busy,
    latestRun,
    appLogsRun,
    startAppLogs,
    syncRepos,
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
    stories,
    storiesError,
    loadingStories,
    tenantConnected: state.tenant !== null,
    answersDraft,
    targetRepoDir,
    removing,
    confirmRemove,
    bootstrap,
    saveAnswersAndRerun,
    docker,
    diagnose,
    retryFix,
    dismissTriage,
    instruct,
    dismissChange,
    shipChange,
    saveEnv,
    plans,
    activePlan,
    setActivePlanSlug: setSelectedPlanSlug,
    anyStoryRunning,
    planBlocked,
    generateSpec,
    refineSpec,
    approvePlan,
    implementStory,
    moveStory,
    refreshStories,
    implement,
    startIde,
    stopIde,
    removeProject,
    refreshFiles,
    stopRun: runsApi.stop,
    setActiveFile,
    setAnswersDraft,
    setTargetRepoDir,
    setConfirmRemove,
    openExternal: (url: string) => void window.mvpfy.openExternal(url),
  };
}

/** Non-empty trimmed content of a repo file from the loaded set, or null. */
function contentOf(files: RepoFile[], name: string): string | null {
  const f = files.find((x) => x.relativePath === name && x.exists);
  const text = f?.content?.trim();
  return text ? text : null;
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
