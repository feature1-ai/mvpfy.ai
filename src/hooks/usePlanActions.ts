import { useCallback, useEffect, useRef, useState } from 'react';
import { planFileFor, specFileFor } from '../../shared/types';
import { startPlanSpecRun, startPlanStoryRun } from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import {
  canMove,
  parsePlan,
  ProjectPlan,
  serializePlan,
  slugForFeature,
  StoryLane,
} from '../lib/plan';
import { ControllerContext, contentOf } from './controllerContext';

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

/** Feature planning: spec generation, the story board, and its move policy. */
export interface PlanActions {
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
}

export function usePlanActions(ctx: ControllerContext): PlanActions {
  const { project, state, updateState, runsApi, projectRuns, pf, files, refreshFiles, guarded } =
    ctx;

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
  // not race them. Spec generation only writes its own plan/spec pair, and the
  // readiness check writes only its own report, so both may overlap with
  // anything — including stories of other features.
  const planBlocked = projectRuns.some(
    (r) =>
      r.running && !['app-logs', 'plan-spec', 'plan-story', 'readiness'].includes(r.handle.kind)
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

  return {
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
  };
}
