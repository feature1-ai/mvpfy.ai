import { useEffect, useRef, useState } from 'react';
import {
  ANSWERS_FILE,
  ComposeAction,
  QUESTIONS_FILE,
  ServiceState,
  TRIAGE_FILE,
} from '../../shared/types';
import {
  startAppLogsRun,
  startSeedRun,
  makeRunId,
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
import { parseTunnelUrl, tunnelRefused } from '../lib/tunnel';

/** Environment and workspace lifecycle: bootstrap, docker, triage, IDE, env
 *  file, repo sync, and project removal. */
export interface ProjectActions {
  bootstrap(): Promise<boolean>;
  saveAnswersAndRerun(): Promise<boolean>;
  docker(action: Exclude<ComposeAction, 'logs'>): Promise<boolean>;
  /** Run setup again on a project that already has generated files. */
  rebootstrap(): Promise<boolean>;
  /** Run the project's recorded seed command. */
  seed(): Promise<boolean>;
  /** Restarting and diagnosing have both been tried; this needs a person. */
  recoveryExhausted: boolean;
  /** Feed the failed run's log to the agent: plain-language diagnosis + fix. */
  diagnose(): Promise<boolean>;
  /** Re-run the step the triage file says to retry. */
  retryFix(): Promise<boolean>;
  dismissTriage(): Promise<boolean>;
  saveEnv(name: string, content: string): Promise<boolean>;
  /** Pull the latest changes from each repo's remote into the clone. */
  syncRepos(): Promise<boolean>;
  /** Point one repo at a remote and push what it has. */
  addRemote(dir: string, url: string): Promise<boolean>;
  /** The public address this app is shared on, while a share is running. */
  shareUrl: string | null;
  /** True once a share has started but before its address exists. */
  shareStarting: boolean;
  /** Cloudflare refused the tunnel — the link is not coming. */
  shareRefused: boolean;
  /** True when the tunnel client is installed. */
  canShare: boolean;
  /** Put the running app on the internet until it is stopped. */
  startShare(): Promise<boolean>;
  /** Take it off again. */
  stopShare(): void;
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
  appLogsRun: RunState | null,
  /** The app started but never answered — a failure with no failed run. */
  unresponsive: boolean,
  stoppedServices: ServiceState[],
  /** The app is answering — the moment it is safe to seed. */
  appHealthy: boolean
): ProjectActions {
  const { project, state, updateState, runsApi, projectRuns, pf, files, refreshFiles, guarded } =
    ctx;
  const [answersDraft, setAnswersDraft] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Phase B is started by the effect below rather than by the caller, so the
  // fact that this is a regeneration has to outlive the call that began it.
  const regenerating = useRef(false);

  /** Phase B: the run that actually makes the repo runnable. */
  const bootstrapWork = () =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      // Re-verify the port right before generating: it is baked into the
      // compose file, so it must be genuinely free at bootstrap time.
      const freePort = await window.mvpfy.findFreePort(project.basePort);
      const target = { ...project, basePort: freePort };
      const handle = await startBootstrapRun(target, state.settings, regenerating.current);
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
  const bootstrap = (regenerate = false) =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      regenerating.current = regenerate;
      const handle = await startBootstrapPlanRun(project, state.settings, regenerate);
      runsApi.track(handle);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id ? { ...p, status: 'bootstrapping', bootstrapAccepted: false } : p
        ),
      }));
    });

  // Answers and retries resume the work directly: the task list already exists
  // and the PM is watching those cards — re-planning would throw them away.
  const saveAnswersAndRerun = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, pf(ANSWERS_FILE), answersDraft);
      setAnswersDraft('');
      await bootstrapWork();
    });

  /**
   * Set the project up again from scratch. The generated files may predate
   * the mvpfy that is running now — this is how a project written by an older
   * version gets what a new one would have written. Data volumes and the app's
   * own code are never touched; the agent backs up what it replaces.
   */
  const rebootstrap = () => bootstrap(true);

  const seed = () =>
    guarded(async () => {
      const handle = await startSeedRun(project);
      if (handle) runsApi.track(handle);
    });

  /**
   * Seed once the app is answering — not when `up` returns, which is as soon as
   * containers have started and a database may still be coming up.
   *
   * Hanging it off the app responding rather than off the start run means
   * every route to a running app seeds: the bootstrap chain, a manual start, a
   * restart, and the retry after Diagnose & fix. None of them has to remember.
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!appHealthy) return;
    const startId = projectRuns.filter((r) => r.handle.kind === 'docker-up').pop()?.handle.runId;
    if (!startId || seededFor.current === startId) return;
    seededFor.current = startId;
    queueMicrotask(() => void seed());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appHealthy, projectRuns]);

  const docker = (action: Exclude<ComposeAction, 'logs'>) =>
    guarded(async () => {
      const handle = await startDockerRun(project, action);
      runsApi.track(handle);
    });

  // Setup runs itself end to end: the task list flows into the work, and the
  // work flows into starting the app — each step once per run, even if
  // several renders observe the same completion. The PM's own gate is the
  // last card, where they say whether they can actually use the thing.
  const chained = useRef(new Set<string>());
  useEffect(() => {
    for (const run of projectRuns) {
      if (run.running || run.exitCode !== 0) continue;
      if (chained.current.has(run.handle.runId)) continue;
      if (run.handle.kind === 'bootstrap-plan') {
        chained.current.add(run.handle.runId);
        void bootstrapWork();
      } else if (run.handle.kind === 'bootstrap') {
        // A blocked agent writes its questions and stops, but still exits 0 —
        // starting a half-configured stack would bury the questions the PM
        // needs to answer.
        if (contentOf(files, pf(QUESTIONS_FILE))) continue;
        chained.current.add(run.handle.runId);
        void docker('up');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRuns]);

  const diagnose = () =>
    guarded(async () => {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      // An app that started and died leaves no failed run: `up -d` exits zero
      // once containers start. The starting run's own log is then the evidence,
      // and the container states say which service went.
      const failed = lastFailure ?? (unresponsive ? 'docker-up' : 'bootstrap');
      const failedRun = Object.values(runsApi.runs)
        .filter((r) => r.handle.projectId === project.id && r.handle.kind === failed)
        .pop();
      const stopped = stoppedServices
        .map((sv) => `${sv.service}: ${sv.state}${sv.exitCode ? ` (exit ${sv.exitCode})` : ''}`)
        .join('\n');
      const containerNote = stopped
        ? `\n\nThese services are not running:\n${stopped}\nRead their container logs to find out why.`
        : unresponsive
          ? '\n\nEvery container is running, but nothing answers on the app port. The app is ' +
            'likely failing during startup, or listening on a different port than the compose ' +
            'file publishes.'
          : '';
      const logTail =
        (failedRun && failedRun.log.trim()
          ? failedRun.log.slice(-4000)
          : '(log unavailable — the app was restarted after the failure or the run was ' +
            'interrupted; inspect the workspace to infer what happened)') + containerNote;
      const handle = await startTriageRun(
        project,
        state.settings,
        failed === 'docker-up'
          ? unresponsive
            ? 'starting the environment — the containers started but the app never answered'
            : 'starting the environment (docker compose up)'
          : 'bootstrap',
        logTail
      );
      runsApi.track(handle);
    });

  /**
   * Getting an unresponsive app back, cheapest first, and with an end.
   *
   * The commonest reason an app is silent on a start is a race — it comes up
   * before the database is accepting connections, dies, and `up -d` still
   * exits zero because they did both start. A restart fixes exactly that, for
   * nothing.
   *
   * But a restart IS another start, so counting attempts per start run never
   * ends: each retry resets its own guard and the app cycles between stopping
   * and starting forever. The count belongs to the episode — which lasts until
   * the app answers — not to a run.
   *
   * Three restarts, then one diagnosis, then stop. Whatever survives that is
   * not a race, and not something another attempt will change.
   */
  const MAX_RESTARTS = 3;
  const recovery = useRef({ restarts: 0, diagnosed: false });
  const [recoveryExhausted, setRecoveryExhausted] = useState(false);

  // A working app ends the episode: the next failure starts from zero.
  useEffect(() => {
    if (!appHealthy) return;
    recovery.current = { restarts: 0, diagnosed: false };
    if (recoveryExhausted) queueMicrotask(() => setRecoveryExhausted(false));
  }, [appHealthy, recoveryExhausted]);

  const actedOnStart = useRef<string | null>(null);
  const lastStart = projectRuns.filter((r) => r.handle.kind === 'docker-up').pop();
  const lastStartId = lastStart && !lastStart.running ? lastStart.handle.runId : null;
  // Something else running is reason enough for the app to be quiet: a pull
  // changes the source under it, an implement rewrites it, an instruct edits
  // its config. None of those is a start that failed, and restarting through
  // one fights whatever is working.
  const somethingElseRunning = projectRuns.some(
    (r) => r.running && r.handle.kind !== 'app-logs' && r.handle.kind !== 'docker-up'
  );
  useEffect(() => {
    if (!unresponsive || !lastStartId || somethingElseRunning) return;
    if (actedOnStart.current === lastStartId) return;
    actedOnStart.current = lastStartId;
    const state = recovery.current;
    if (state.restarts < MAX_RESTARTS) {
      state.restarts += 1;
      queueMicrotask(() => void docker('restart'));
      return;
    }
    if (!state.diagnosed) {
      state.diagnosed = true;
      // The free fixes are spent; this is where the agent earns its run. It
      // writes a fix and stops — retrying is the PM's, because starting again
      // automatically would begin the whole cycle over.
      queueMicrotask(() => void diagnose());
      return;
    }
    queueMicrotask(() => setRecoveryExhausted(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unresponsive, lastStartId, somethingElseRunning]);

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

  /**
   * Bring the workspace up to date with everyone else's work.
   *
   * A plain pull is wrong whenever a feature is being tested: the workspace is
   * then detached at one of that feature's commits, and pulling into a detached
   * HEAD updates nothing anyone will see. So the feature is put down first, the
   * trunk is pulled onto the trunk, the new trunk is merged into the feature's
   * own branch in its own checkout, and the feature is picked back up — now
   * standing on top of what everyone else has landed rather than beside it.
   *
   * Each step waits for the one before it. They are separate runs so the log
   * says which part failed, and so a merge conflict stops at the merge with the
   * pull already done rather than undoing it.
   */
  const syncRepos = () =>
    guarded(async () => {
      const slug = project.testingSlug ?? null;
      const dirs = project.repos.map((r) => r.dir);
      if (slug) {
        await window.mvpfy.checkoutFeature(project.localPath, dirs, null);
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, testingSlug: null } : p
          ),
        }));
      }
      const handle = await startSyncRun(project);
      runsApi.track(handle);
      if (!slug) return;
      const code = await runsApi.completed(handle.runId);
      // A failed pull means there is nothing new to merge, and merging a trunk
      // that did not move would only add an empty commit.
      if (code !== 0) return;
      const merge = { runId: makeRunId('merge'), kind: 'sync' as const, projectId: project.id };
      runsApi.track(merge);
      await window.mvpfy.mergeTrunk(
        merge.runId,
        project.localPath,
        dirs,
        `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`,
        slug,
        `mvpfy/${slug || 'feature'}`
      );
      await runsApi.completed(merge.runId);
      // Back onto the feature last, so what comes up is the merged commit and
      // not the one it was standing on before the pull.
      await window.mvpfy.checkoutFeature(project.localPath, dirs, slug);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => (p.id === project.id ? { ...p, testingSlug: slug } : p)),
      }));
    });

  // The way back for a project started with no remote. Everything but raising
  // a pull request works without one, so "none for now" is a real choice —
  // which it only is if there is somewhere to change your mind.
  const addRemote = (dir: string, url: string) =>
    guarded(async () => {
      const address = url.trim();
      if (!address) return;
      const runId = makeRunId('add-remote');
      runsApi.track({ runId, kind: 'sync', projectId: project.id });
      await window.mvpfy.addRemote(runId, project.localPath, dir, address);
      const code = await runsApi.completed(runId);
      if (code !== 0) return;
      // Only once the push worked: a url recorded for a remote that refused it
      // would be the project claiming something that is not true.
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id
            ? { ...p, repos: p.repos.map((r) => (r.dir === dir ? { ...r, url: address } : r)) }
            : p
        ),
      }));
    });

  // A share is a run like any other, which is what makes stopping it, reading
  // its output and surviving a crash all work without anything new.
  const shareRun = projectRuns.filter((r) => r.handle.kind === 'share').pop() ?? null;
  const liveShare = shareRun?.running ? shareRun : null;
  const shareUrl = liveShare ? parseTunnelUrl(liveShare.log) : null;
  const shareRefused = Boolean(liveShare) && tunnelRefused(liveShare!.log);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    void window.mvpfy
      .canShare()
      .then(setCanShare)
      .catch(() => setCanShare(false));
  }, []);

  const startShare = () =>
    guarded(async () => {
      if (liveShare) return;
      const runId = makeRunId('share');
      runsApi.track({ runId, kind: 'share', projectId: project.id });
      await window.mvpfy.startShare(runId, project.localPath, project.basePort);
    });

  const stopShare = () => {
    if (liveShare) runsApi.stop(liveShare.handle.runId);
  };

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
    rebootstrap,
    seed,
    recoveryExhausted,
    diagnose,
    retryFix,
    dismissTriage,
    saveEnv,
    syncRepos,
    addRemote,
    shareUrl,
    shareStarting: Boolean(liveShare) && !shareUrl && !shareRefused,
    shareRefused,
    canShare,
    startShare,
    stopShare,
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
