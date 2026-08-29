import { useEffect, useState } from 'react';
import { BOOTSTRAP_FILE } from '../../shared/types';
import {
  bareFilePath,
  parseBootstrapFlow,
  resolveFlow,
  ResolvedTask,
  RUNNING_TASK_ID,
} from '../lib/bootstrapPlan';
import { ControllerContext, contentOf } from './controllerContext';

export interface BootstrapFlowState {
  /** The setup board: agent tasks, then mvpfy's human-gated final card. */
  bootstrapTasks: ResolvedTask[];
  /** The agent's one-line reading of what this product is. */
  bootstrapSummary: string | null;
  /** The PM confirms the last card — the only way it reaches Done. */
  acceptBootstrap(): Promise<boolean>;
  /** Undo that confirmation (back to Ready to test). */
  reopenBootstrap(): Promise<boolean>;
}

/**
 * Reads the agent's bootstrap task list and resolves it against what mvpfy can
 * actually see on disk. The agent's claims never decide a card by themselves:
 * a task is Done when its declared files exist, and the final card belongs to
 * the PM.
 */
export function useBootstrapFlow(ctx: ControllerContext, appHealthy: boolean): BootstrapFlowState {
  const { project, files, pf, projectRuns, updateState, guarded } = ctx;
  const flow = parseBootstrapFlow(contentOf(files, pf(BOOTSTRAP_FILE)));

  // Tasks declare arbitrary files, so their existence needs its own read —
  // refreshFiles only loads the fixed set of names mvpfy knows in advance.
  const declared = [...new Set((flow?.tasks ?? []).flatMap((t) => t.files.map(bareFilePath)))];
  const declaredKey = declared.join('|');
  const runningCount = projectRuns.filter((r) => r.running).length;
  // Keyed by the file list it answers, so a result never outlives the task
  // list that asked for it (a re-plan changes what counts as evidence).
  const [checked, setChecked] = useState<{ key: string; files: string[] }>({ key: '', files: [] });

  useEffect(() => {
    if (!declaredKey) return;
    const wanted = declaredKey.split('|');
    let cancelled = false;
    void window.mvpfy.readRepoFiles(project.localPath, wanted.map(pf)).then((result) => {
      if (cancelled) return;
      setChecked({ key: declaredKey, files: wanted.filter((_, i) => result[i]?.exists) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declaredKey, project.localPath, runningCount]);
  const presentFiles = checked.key === declaredKey ? checked.files : [];

  const setupRunning = projectRuns.some(
    (r) => r.running && (r.handle.kind === 'bootstrap' || r.handle.kind === 'bootstrap-plan')
  );

  const bootstrapTasks = resolveFlow(flow, {
    presentFiles,
    running: setupRunning,
    appHealthy,
    accepted: project.bootstrapAccepted === true,
  });

  const setAccepted = (accepted: boolean) =>
    guarded(async () => {
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id ? { ...p, bootstrapAccepted: accepted } : p
        ),
      }));
    });

  return {
    bootstrapTasks: flow ? bootstrapTasks : [],
    bootstrapSummary: flow?.summary || null,
    acceptBootstrap: () => setAccepted(true),
    reopenBootstrap: () => setAccepted(false),
  };
}

export { RUNNING_TASK_ID };
