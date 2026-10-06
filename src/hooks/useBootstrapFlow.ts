import { useEffect, useState } from 'react';
import { BOOTSTRAP_FILE } from '../../shared/types';
import {
  bareFilePath,
  parseBootstrapFlow,
  resolveFlow,
  ResolvedTask,
  RUNNING_TASK_ID,
} from '../lib/bootstrapPlan';
import {
  ComponentDecision,
  ComponentKind,
  ProductComponent,
  addComponent,
  needsAnswer,
  parseComponents,
  validRemoteUrl,
  withDecision,
} from '../lib/components';
import { Tenancy, parseTenancy, validTenant } from '../lib/tenancy';
import { ControllerContext, contentOf } from './controllerContext';

export interface BootstrapFlowState {
  /** What this product is made of, as setup read it. */
  productComponents: ProductComponent[];
  /** True while a part of the product is missing and unanswered. */
  componentsNeedAnswer: boolean;
  /**
   * Answer for one part, so setting up builds the right thing. `url` is where
   * it already runs, for the parts that should not run here at all.
   */
  decideComponent(id: string, decision: ComponentDecision, url?: string): Promise<boolean>;
  /** Name a part of the product that reading the code never found. */
  addProductComponent(name: string, kind: ComponentKind): Promise<boolean>;
  /** How this product picks a customer, and who it is here. */
  tenancy: Tenancy | null;
  /** Say which customer this machine should be. */
  setLocalTenant(value: string): Promise<boolean>;
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
  const { project, files, pf, projectRuns, updateState, refreshFiles, guarded } = ctx;
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

  // What the product is made of, read from the same file as the tasks. The
  // answer to a missing one is written back there, because the run that builds
  // the environment reads that file and nothing else.
  const bootstrapRaw = contentOf(files, pf(BOOTSTRAP_FILE));
  const productComponents = parseComponents(bootstrapRaw);

  const writeComponents = async (next: ProductComponent[]) => {
    if (!bootstrapRaw?.trim()) throw new Error('Setting up has not read your product yet.');
    const parsed = JSON.parse(bootstrapRaw) as Record<string, unknown>;
    await window.mvpfy.writeRepoFile(
      project.localPath,
      pf(BOOTSTRAP_FILE),
      JSON.stringify({ ...parsed, components: next }, null, 2)
    );
    refreshFiles();
  };

  const addProductComponent = (name: string, kind: ComponentKind) =>
    guarded(async () => {
      await writeComponents(addComponent(productComponents, name, kind));
    });

  const tenancy = parseTenancy(bootstrapRaw);
  const setLocalTenant = (value: string) =>
    guarded(async () => {
      const local = value.trim();
      if (!validTenant(local)) {
        throw new Error('Letters, numbers, dots, dashes and underscores — it goes into a hostname');
      }
      if (!bootstrapRaw?.trim() || !tenancy) return;
      const parsed = JSON.parse(bootstrapRaw) as Record<string, unknown>;
      await window.mvpfy.writeRepoFile(
        project.localPath,
        pf(BOOTSTRAP_FILE),
        JSON.stringify({ ...parsed, tenancy: { ...tenancy, local } }, null, 2)
      );
      refreshFiles();
    });

  const decideComponent = (id: string, decision: ComponentDecision, url?: string) =>
    guarded(async () => {
      if (!bootstrapRaw?.trim()) return;
      if (decision === 'remote' && !validRemoteUrl(url)) {
        throw new Error('That is not an address — it needs to start with http:// or https://');
      }
      await writeComponents(withDecision(productComponents, id, decision, url));
    });

  return {
    bootstrapTasks: flow ? bootstrapTasks : [],
    bootstrapSummary: flow?.summary || null,
    productComponents,
    componentsNeedAnswer: needsAnswer(productComponents),
    decideComponent,
    addProductComponent,
    tenancy,
    setLocalTenant,
    acceptBootstrap: () => setAccepted(true),
    reopenBootstrap: () => setAccepted(false),
  };
}

export { RUNNING_TASK_ID };
