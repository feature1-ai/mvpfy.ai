import { useCallback, useEffect, useState } from 'react';
import {
  ANSWERS_FILE,
  GENERATED_FILES,
  MvpfyState,
  Project,
  QUESTIONS_FILE,
  RepoFile,
} from '../../shared/types';
import {
  startBootstrapRun,
  startDockerRun,
  startIdeRun,
  startShipFeatureRun,
} from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import { DemoCredential, parseDemoCredentials } from '../lib/credentials';
import { Feature1McpClient, UserStory } from '../lib/feature1Mcp';
import { MobilePreview, parseMobilePreview } from '../lib/mobile';
import { RunsApi, RunState } from '../lib/useRuns';

export type UpdateState = (mutate: (prev: MvpfyState) => MvpfyState) => void;

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
  lastShipPrUrl: string | null;
  actionError: string | null;
  hasMvpfyYml: boolean;
  demoCredentials: DemoCredential[];
  mobilePreview: MobilePreview | null;
  questionsFile: RepoFile | null;
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
  bootstrap(): Promise<void>;
  saveAnswersAndRerun(): Promise<void>;
  docker(action: 'up' | 'down'): Promise<void>;
  refreshStories(): Promise<void>;
  implement(story: UserStory): Promise<void>;
  startIde(): Promise<void>;
  stopIde(): Promise<void>;
  removeProject(): Promise<void>;
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

  const latestRun = runsApi.latestForProject(project.id);
  const busy = latestRun?.running ?? false;
  const lastShipRun = Object.values(runsApi.runs)
    .filter((r) => r.handle.projectId === project.id && r.handle.kind === 'ship')
    .pop();

  const refreshFiles = useCallback(() => {
    void window.mvpfy
      .readRepoFiles(project.localPath, [...GENERATED_FILES, QUESTIONS_FILE, ANSWERS_FILE])
      .then((result) => {
        setFiles(result);
        const viewable = result
          .filter((f) => f.exists && f.relativePath !== QUESTIONS_FILE)
          .map((f) => f.relativePath);
        setActiveFile((prev) => (prev && viewable.includes(prev) ? prev : (viewable[0] ?? null)));
        const generated = result
          .filter(
            (f) => f.exists && (GENERATED_FILES as readonly string[]).includes(f.relativePath)
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
  }, [project.id, project.localPath]);

  // Load files on mount and again whenever a run for this project finishes.
  useEffect(() => {
    if (!busy) refreshFiles();
  }, [busy, refreshFiles]);

  // Poll a local port until it answers HTTP so the PM can see when the app
  // (or IDE) is actually ready, not just when its process started.
  useHealthPoll(project.status === 'running' ? project.basePort : null, setAppHealthy, appHealthy);
  const idePort = project.idePort ?? null;
  useHealthPoll(idePort, setIdeHealthy, ideHealthy);

  const hasMvpfyYml = files.some((f) => f.relativePath === 'mvpfy.yml' && f.exists);
  const mvpfyYmlContent = files.find((f) => f.relativePath === 'mvpfy.yml')?.content;

  async function guarded(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
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
      await window.mvpfy.writeRepoFile(project.localPath, ANSWERS_FILE, answersDraft);
      setAnswersDraft('');
      await bootstrap();
    });

  const docker = (action: 'up' | 'down') =>
    guarded(async () => {
      const handle = await startDockerRun(project, action);
      runsApi.track(handle);
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
    appUrl: `http://localhost:${project.basePort}`,
    appHealthy,
    ideUrl: idePort ? `http://localhost:${idePort}` : null,
    ideHealthy,
    ideStarting: latestRun?.running === true && latestRun.handle.kind === 'ide-up',
    busy,
    latestRun,
    lastShipPrUrl: lastShipRun?.prUrl ?? null,
    actionError,
    hasMvpfyYml,
    demoCredentials: parseDemoCredentials(mvpfyYmlContent),
    mobilePreview: parseMobilePreview(mvpfyYmlContent),
    questionsFile: files.find((f) => f.relativePath === QUESTIONS_FILE && f.exists) ?? null,
    viewerFiles: files.filter((f) => f.exists && f.relativePath !== QUESTIONS_FILE),
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
