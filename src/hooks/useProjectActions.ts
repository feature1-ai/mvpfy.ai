import { useEffect, useRef, useState } from 'react';
import { ANSWERS_FILE, TRIAGE_FILE } from '../../shared/types';
import {
  startAppLogsRun,
  startBootstrapPlanRun,
  startBootstrapRun,
  startDockerRun,
  startIdeRun,
  startSyncRun,
  startTriageRun,
} from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import { RunState } from '../lib/useRuns';
import { ControllerContext, contentOf } from './controllerContext';

/** Environment and workspace lifecycle: bootstrap, docker, triage, IDE, env
 *  file, repo sync, and project removal. */
export interface ProjectActions {
  bootstrap(): Promise<boolean>;
  saveAnswersAndRerun(): Promise<boolean>;
  docker(action: 'up' | 'down' | 'restart'): Promise<boolean>;
  /** Feed the failed run's log to the agent: plain-language diagnosis + fix. */
  diagnose(): Promise<boolean>;
  /** Re-run the step the triage file says to retry. */
  retryFix(): Promise<boolean>;
  dismissTriage(): Promise<boolean>;
  saveEnv(name: string, content: string): Promise<boolean>;
  /** Pull the latest changes from each repo's remote into the clone. */
  syncRepos(): Promise<boolean>;
  startAppLogs(): Promise<boolean>;
  startIde(): Promise<boolean>;
  stopIde(): Promise<boolean>;
  removeProject(): Promise<boolean>;
  answersDraft: string;
  setAnswersDraft(text: string): void;
  removing: boolean;
  confirmRemove: boolean;
  setConfirmRemove(value: boolean): void;
}

export function useProjectActions(
  ctx: ControllerContext,
  lastFailure: 'bootstrap' | 'docker-up' | null,
  latestRun: RunState | null,
  appLogsRun: RunState | null
): ProjectActions {
  const { project, state, updateState, runsApi, projectRuns, pf, files, refreshFiles, guarded } =
    ctx;
  const [answersDraft, setAnswersDraft] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  /** Phase B: the run that actually makes the repo runnable. */
  const bootstrapWork = () =>
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

  /**
   * Phase A: work out what setting this product up involves and write it down
   * as cards, before touching anything. The PM gets something to read in ~30s
   * instead of two minutes of silence; the effect below chains phase B.
   */
  const bootstrap = () =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const handle = await startBootstrapPlanRun(project, state.settings);
      runsApi.track(handle);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id ? { ...p, status: 'bootstrapping', bootstrapAccepted: false } : p
        ),
      }));
    });

  // A finished task list flows straight into doing the work — once per run,
  // even if several renders observe the same completion.
  const chained = useRef(new Set<string>());
  useEffect(() => {
    for (const run of projectRuns) {
      if (run.handle.kind !== 'bootstrap-plan' || run.running || run.exitCode !== 0) continue;
      if (chained.current.has(run.handle.runId)) continue;
      chained.current.add(run.handle.runId);
      void bootstrapWork();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRuns]);

  // Answers and retries resume the work directly: the task list already exists
  // and the PM is watching those cards — re-planning would throw them away.
  const saveAnswersAndRerun = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, pf(ANSWERS_FILE), answersDraft);
      setAnswersDraft('');
      await bootstrapWork();
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
        await bootstrapWork();
      }
    });

  const dismissTriage = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, pf(TRIAGE_FILE), '');
      refreshFiles();
    });

  const saveEnv = (name: string, content: string) =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, name, content);
      refreshFiles();
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
    bootstrap,
    saveAnswersAndRerun,
    docker,
    diagnose,
    retryFix,
    dismissTriage,
    saveEnv,
    syncRepos,
    startAppLogs,
    startIde,
    stopIde,
    removeProject,
    answersDraft,
    setAnswersDraft,
    removing,
    confirmRemove,
    setConfirmRemove,
  };
}
