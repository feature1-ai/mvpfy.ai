import { prepareFeaturePreview } from '../lib/prepareFeaturePreview';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RunSession, configDirFor, planFileFor, specFileFor } from '../../shared/types';
import {
  startPlanSpecRun,
  startPlanStoryRun,
  startPullFeatureRun,
  startPushFeatureRun,
  startSyncFeatureRun,
  startFeatureChangeRun,
  startResolveMergeRun,
  startAutoMergeRun,
  isAmbientRun,
  lostConversation,
  makeRunId,
  startGitAuthRun,
  startRaisePrRun,
} from '../lib/agentRunner';
import { Feature1McpClient, mcpBaseUrl } from '../lib/feature1Mcp';
import { preflightAuth } from '../lib/cliCheck';
import { redactSecrets } from '../lib/raiseFailure';
import { quotaExhausted, quotaResetAt } from '../lib/quota';
import { nextAttemptAt, waitFor } from '../lib/quotaWait';
import {
  featureImplemented,
  featurePulled,
  featurePushed,
  quotaBack,
  quotaRanOut,
  quotaStillOut,
} from '../lib/notices';
import {
  MAX_FEATURES_AT_ONCE,
  cannotStartReason,
  featuresRunning,
  storyRunningFor,
} from '../lib/featureRuns';
import {
  canMove,
  parsePlan,
  ProjectPlan,
  serializePlan,
  slugForFeature,
  StoryLane,
} from '../lib/plan';
import { ControllerContext, contentOf } from './controllerContext';
import type { FeatureRepoGit, PullRequestState, StrandedFeature } from '../../shared/types';

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
  /** Pull a Feature1 feature in as a native plan (agent reads it over MCP). */
  pullFeature(featureRef: string): Promise<boolean>;
  /** File a feature planned here in Feature1 — its PRD, stories and ACs. */
  pushFeature(): Promise<boolean>;
  /** True while the active feature is being filed in Feature1. */
  pushingFeature: boolean;
  /** Bring an already-filed feature up to date: spec, stories, their state. */
  syncFeature(): Promise<boolean>;
  /** True while the active feature is being brought up to date. */
  syncingFeature: boolean;
  refineSpec(instruction: string): Promise<boolean>;
  /** The builder accepts the finished feature — the gate before its PR. */
  markFeatureTested(): Promise<boolean>;
  /** Push the feature branch and open a PR in each repo that changed. */
  raisePr(): Promise<boolean>;
  /** Wire gh in as git's credential helper, then raise again. */
  repairGitAuth(): Promise<boolean>;
  /** Put the running app on this feature's code, or back on the trunk. */
  preparingPreview: boolean;
  testFeature(slug: string | null): Promise<boolean>;
  /** The workspace is on this feature but behind its latest commit. */
  testingStale: boolean;
  /** PM agrees with the PRD — reveals the active feature's story board. */
  approvePlan(): Promise<boolean>;
  implementStory(code: string): Promise<boolean>;
  /** What this feature was left holding when a run stopped part-way. */
  stranded: StrandedFeature | null;
  /** Pick the feature back up wherever it stopped, and carry on to the end. */
  continueFeature(): Promise<boolean>;
  /** Remove this feature's board. Its branch and commits are left alone. */
  deleteFeature(): Promise<boolean>;
  /** Attach images of what this feature should look like. */
  addDesign(): Promise<boolean>;
  /** Remove one attached design. */
  removeDesign(name: string): Promise<boolean>;
  /** One design as a data URL, for showing it back. */
  readDesign(slug: string, name: string): Promise<string | null>;
  /** Record where the design lives, for one nobody can open from here. */
  setDesignLinks(links: string[]): Promise<boolean>;
  /** Change this feature's code in plain language; the agent commits it. */
  changeFeature(instruction: string): Promise<boolean>;
  /** True while a change to the active feature is being made. */
  changingFeature: boolean;
  /** What GitHub says about this feature's pull requests. */
  prStates: PullRequestState[];
  /** True while gh is being asked — a refresh that says nothing reads as broken. */
  prStatesLoading: boolean;
  /** Ask GitHub again — checks go red and reviews arrive after the fact. */
  refreshPrStates(): void;
  /** What each repository's checkout of the active feature is holding. */
  featureGit: FeatureRepoGit[];
  /** Commit whatever an agent left uncommitted in this feature's checkouts. */
  commitFeatureWork(): Promise<boolean>;
  /** Merge the trunk into this feature's branch, so it builds on what landed. */
  updateFeature(): Promise<boolean>;
  /** True when this feature was updated with the trunk in this sitting. */
  justUpdated: boolean;
  /** Resolve a merge left open in this feature's checkouts, and commit it. */
  resolveMerge(): Promise<boolean>;
  /** Abandon a merge left open, putting the feature back as it was. */
  abandonMerge(): Promise<boolean>;
  /** Implement every remaining story in the active feature, in order. */
  implementFeature(): Promise<boolean>;
  /** The features whose stories are being worked through, if any. */
  runningFeatures: string[];
  /** Why this feature cannot start implementing now, or null when it can. */
  cannotImplement(slug: string): string | null;
  /** Work through several features at once, the rest waiting their turn. */
  implementFeatures(slugs: string[]): Promise<boolean>;
  /** Features picked but waiting for room. */
  queuedFeatures: string[];
  /** A feature paused on quota, and when it will carry on by itself. */
  quotaWait: { slug: string; at: Date } | null;
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
  const [preparingPreview, setPreparingPreview] = useState(false);
  const previewLock = useRef(false);
  const planBlocked =
    preparingPreview ||
    projectRuns.some(
      (r) =>
        r.running &&
        // A followed log stream and a live share are not work in progress. This
        // list had its own copy of that rule and only one of the two was ever
        // updated, so sharing an app quietly disabled implementing on every
        // feature — the same defect as before, in the second place it lived.
        !isAmbientRun(r.handle.kind) &&
        !['plan-spec', 'plan-story', 'readiness'].includes(r.handle.kind)
    );
  const processedPlanRuns = useRef(new Set<string>());
  // The feature being worked through story by story. Session-only on purpose:
  // a run that was interrupted by a quit should not silently resume itself.
  // One per feature, not one for the project. Each feature's stories run in
  // order within that feature; different features have nothing in common to
  // race over, so they run beside each other.
  const [runAll, setRunAll] = useState<string[]>([]);
  // Features asked for while the limit was full. Picking four features and
  // being told "three at a time" is a worse answer than starting three and
  // remembering the fourth, which is what somebody picking four meant.
  const [queued, setQueued] = useState<string[]>([]);

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

  // Feature1 MCP config for this tenant: URL + keychain token. Throws with a
  // clear message when Feature1 isn't connected or the session has expired,
  // so pull/implement-from-Feature1 fail loudly rather than silently.
  // Kept current from an effect rather than during render. The check below
  // happens after a network round trip, by which time the effect has long
  // run — so the reading is the same and nothing is written while rendering.
  const activeTenant = useRef(state.tenant);
  useEffect(() => {
    activeTenant.current = state.tenant;
  }, [state.tenant]);
  const feature1Mcp = useCallback(async () => {
    if (!state.tenant) throw new Error('Connect Feature1 in Settings first.');
    const entry = state.tenant.tokenKeychainEntry;
    const token = entry ? await window.mvpfy.keychainGet(entry) : null;
    if (!token)
      throw new Error('Feature1 session expired — reconnect with your own token in Settings.');
    await new Feature1McpClient(state.tenant.slug, token).verifyIdentity();
    if (activeTenant.current !== state.tenant)
      throw new Error('Feature1 connection changed. Try again.');
    return { url: mcpBaseUrl(state.tenant.slug), token };
  }, [state.tenant]);

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

  // Every pull request the raise printed — a multi-repo feature opens one per
  // repository that changed, so a single URL would lose the rest.
  const prRuns = projectRuns.filter((r) => r.handle.kind === 'raise-pr');
  const processedPrRuns = useRef(new Set<string>());
  useEffect(() => {
    for (const run of prRuns) {
      // Not `exitCode !== 0`: the repos are chained, so one failing fails the
      // run while the pull requests already opened before it are real. Reading
      // the log either way keeps those rather than throwing them away with the
      // failure — and the panel below still explains what did not happen.
      if (run.running) continue;
      if (processedPrRuns.current.has(run.handle.runId)) continue;
      const slug = run.handle.planSlug ?? '';
      const plan = plans.find((p) => p.slug === slug)?.plan;
      if (!plan) continue;
      processedPrRuns.current.add(run.handle.runId);
      // A run that never reached the shell — a failed sign-in preflight, say —
      // has no command echo and no push output. Storing its message as the last
      // raise would replace a real attempt's log with something that never ran,
      // and the panel would then explain the wrong failure after a reload. The
      // message is already on screen; it just does not outlive the session.
      if (!run.log.startsWith('$ ')) continue;
      const urls = [...new Set(run.log.match(/https:\/\/\S*\/pull\/\d+/g) ?? [])];
      void writePlan(slug, {
        ...plan,
        prUrls: [...new Set([...(plan.prUrls ?? []), ...urls])],
        lastRaise: { log: redactSecrets(run.log.slice(-12000)), exitCode: run.exitCode },
      });
      // A failed or cancelled push must keep its checkout and unpushed work.
      if (run.exitCode !== 0) continue;
      // Nobody to review it: GitHub holds each pull request and merges it when
      // its checks pass. Armed here rather than merged here — a red check must
      // leave the pull request open exactly as it would have been.
      if (project.autoMerge && urls.length > 0) {
        void startAutoMergeRun(project, slug, urls).then(runsApi.track);
      }
      // Testing this feature is over, so the workspace goes back to its trunk.
      // Done here rather than through the action so the effect does not depend
      // on something declared below it.
      if (project.testingSlug === slug) {
        void window.mvpfy
          .checkoutFeature(
            project.localPath,
            project.repos.map((r) => r.dir),
            null
          )
          .then(() =>
            updateState((prev) => ({
              ...prev,
              projects: prev.projects.map((p) =>
                p.id === project.id ? { ...p, testingSlug: null } : p
              ),
            }))
          );
      }
      // The branch is pushed, so the checkouts hold nothing that is not also
      // on the remote. Recreated from it if the feature comes back.
      void window.mvpfy.worktree(
        project.localPath,
        project.repos.map((r) => r.dir),
        `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`,
        slug,
        `mvpfy/${slug || 'feature'}`,
        'remove'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prRuns, plans]);

  /**
   * Run the app from a feature's code. There is one working copy, so this
   * replaces whatever was under test — said plainly in the UI, because a
   * builder accepting a story against the wrong branch is the failure that
   * matters here.
   */
  const testFeature = (slug: string | null) =>
    guarded(async () => {
      if (previewLock.current || planBlocked || anyStoryRunning) {
        throw new Error('Wait for the current work to finish before preparing a feature preview.');
      }
      previewLock.current = true;
      setPreparingPreview(true);
      try {
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, testingSlug: null } : p
          ),
        }));
        await prepareFeaturePreview(
          project,
          slug,
          Boolean(contentOf(files, pf('mvpfy.yml'))),
          runsApi
        );
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, testingSlug: slug } : p
          ),
        }));
      } finally {
        previewLock.current = false;
        setPreparingPreview(false);
      }
    });

  /**
   * Whether the workspace is still showing the feature it claims to be. HEAD
   * was detached at a commit, so a story implemented since has moved the
   * branch past it; asking git is the only way to know.
   */
  const testingSlug = project.testingSlug ?? null;
  // Re-asked whenever a story finishes, since that is exactly what moves the
  // branch past us. Stamped with the question it answered, so a result cannot
  // outlive it and no effect has to reset the state.
  const runningStories = storyRuns.filter((r) => r.running).length;
  const testingKey = testingSlug ? `${testingSlug}:${runningStories}` : '';
  const [staleCheck, setStaleCheck] = useState({ key: '', stale: false });
  useEffect(() => {
    if (!testingKey) return;
    let cancelled = false;
    void window.mvpfy
      .featureCheckedOut(
        project.repos.map((r) => r.dir),
        `mvpfy/${testingSlug || 'feature'}`
      )
      .then((current) => {
        if (!cancelled) setStaleCheck({ key: testingKey, stale: !current });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testingKey, project.repos]);
  const testingStale = staleCheck.key === testingKey && staleCheck.stale;

  /**
   * Being signed in to gh is not the same as git being able to use it, and the
   * gap between them is the commonest reason a push fails. Wiring it up is one
   * command, so mvpfy runs it rather than printing it.
   */
  const repairGitAuth = () =>
    guarded(async () => {
      await startGitAuthRun(project, runsApi.track);
    });

  const markFeatureTested = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) return;
      await writePlan(active.slug, { ...active.plan, tested: true });
    });

  const raisePr = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) return;
      // Pushing and opening a pull request are git and gh, and nothing else.
      // Without a GitHub sign-in the push fails and the run exits non-zero,
      // which read as the button doing nothing at all.
      const authProblem = await preflightAuth(null, true);
      if (authProblem) throw new Error(authProblem);
      const feature = active.plan.spec.feature || active.slug || 'feature';
      const stories = active.plan.stories.map((st) => `- ${st.code} ${st.title}`).join('\n');
      await startRaisePrRun(
        project,
        active.slug,
        `mvpfy/${active.slug || 'feature'}`,
        feature,
        `${active.plan.spec.overview.summary}\n\n## Stories\n${stories}\n\n— planned and implemented with mvpfy`,
        runsApi
      );
    });

  /**
   * The conversation this feature owns. The first run of a feature opens one;
   * everything after continues it, so refining a spec knows why the spec says
   * what it does instead of re-deriving it from the file.
   *
   * Claude only — codex can resume a conversation but cannot be told which id
   * to give a new one, so there is nothing to hand it up front.
   */
  const sessionFor = useCallback(
    (slug: string, open: boolean): RunSession | undefined => {
      if (state.settings.defaultAgent !== 'claude') return undefined;
      const existing = project.featureSessions?.[slug];
      if (existing && !open) return { id: existing, resume: true };
      const id = existing && open ? existing : crypto.randomUUID();
      if (id !== existing) {
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id
              ? { ...p, featureSessions: { ...(p.featureSessions ?? {}), [slug]: id } }
              : p
          ),
        }));
      }
      return { id, resume: false };
    },
    [project.id, project.featureSessions, state.settings.defaultAgent, updateState]
  );

  /**
   * A conversation that cannot be resumed must not strand the feature. Forget
   * it and the next attempt opens a fresh one — the plan and spec files carry
   * everything that matters anyway.
   */
  const forgetSession = useCallback(
    (slug: string) => {
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => {
          if (p.id !== project.id) return p;
          const rest = { ...(p.featureSessions ?? {}) };
          delete rest[slug];
          return { ...p, featureSessions: rest };
        }),
      }));
    },
    [project.id, updateState]
  );

  // A resumed run that failed may simply have lost its conversation; drop it so
  // pressing the button again works rather than failing the same way.
  const failedRuns = projectRuns.filter(
    (r) => !r.running && r.exitCode !== 0 && r.handle.planSlug !== undefined
  );
  // Held in a ref because implementStory is declared further down; reading it
  // directly here would be a use before declaration.
  const implementStoryRef = useRef<
    ((code: string, continuing?: boolean) => Promise<boolean>) | null
  >(null);
  const processedFailures = useRef(new Set<string>());
  // One automatic retry per feature, so a conversation that was never there
  // cannot become a loop of runs each opening and failing in turn.
  const reopened = useRef(new Set<string>());
  useEffect(() => {
    for (const run of failedRuns) {
      if (processedFailures.current.has(run.handle.runId)) continue;
      processedFailures.current.add(run.handle.runId);
      const slug = run.handle.planSlug ?? '';
      forgetSession(slug);
      // A story that asked to resume a conversation that does not exist has
      // not failed at anything — nothing was attempted. Forgetting the id and
      // making the person press the button again shows them an error about
      // our own bookkeeping, so it just goes again, once.
      if (
        run.handle.kind === 'plan-story' &&
        run.handle.storyId &&
        lostConversation(run.log) &&
        !reopened.current.has(slug)
      ) {
        reopened.current.add(slug);
        const code = run.handle.storyId;
        queueMicrotask(() => void implementStoryRef.current?.(code, true));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedRuns]);

  const generateSpec = (description: string) =>
    guarded(async () => {
      const text = description.trim();
      if (!text) return;
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const slug = slugForFeature(text, ['', ...(project.planSlugs ?? [])]);
      const handle = await startPlanSpecRun(
        project,
        state.settings,
        slug,
        text,
        undefined,
        sessionFor(slug, true)
      );
      runsApi.track(handle);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id
            ? {
                ...p,
                planSlugs: [...(p.planSlugs ?? []), slug],
                featureAsks: { ...(p.featureAsks ?? {}), [slug]: text },
              }
            : p
        ),
      }));
      setSelectedPlanSlug(slug);
    });

  const pullFeature = (featureRef: string) =>
    guarded(async () => {
      const ref = featureRef.trim();
      if (!ref) return;
      // Guarded here as well as hidden in the list, because the reference can
      // also be typed in — and a second board for one Feature1 feature splits
      // its stories across two places that each think they are the whole thing.
      const already = Object.entries(project.feature1Refs ?? {}).find(
        ([, r]) => r.toLowerCase() === ref.toLowerCase()
      );
      const fromPlan = plans.find(
        (pl) => (pl.plan?.feature1FeatureRef ?? '').toLowerCase() === ref.toLowerCase()
      );
      if (already || fromPlan) {
        setSelectedPlanSlug(already?.[0] ?? fromPlan!.slug);
        throw new Error(`${ref} is already here — opened it rather than pulling it again.`);
      }
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const mcp = await feature1Mcp();
      // Slug the plan off the feature ref; the agent fills the real name.
      const slug = slugForFeature(`feature1 ${ref}`, ['', ...(project.planSlugs ?? [])]);
      const handle = await startPullFeatureRun(
        project,
        state.settings,
        slug,
        ref,
        mcp,
        sessionFor(slug, true)
      );
      runsApi.track(handle);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id
            ? {
                ...p,
                planSlugs: [...(p.planSlugs ?? []), slug],
                // Recorded now, not when the run finishes writing the plan:
                // until something knows this feature is being pulled, it stays
                // on offer and the next click starts a second board for it.
                feature1Refs: { ...(p.feature1Refs ?? {}), [slug]: ref },
              }
            : p
        ),
      }));
      setSelectedPlanSlug(slug);
    });

  // What the feature's checkouts are actually holding, read from git rather
  // than from any run's account of itself. Re-read whenever a run of this
  // project finishes, since that is when it can have changed.
  const [featureGit, setFeatureGit] = useState<FeatureRepoGit[]>([]);
  const gitKey = `${activePlan?.slug ?? ''}:${projectRuns.filter((r) => !r.running).length}`;
  const readGit = useRef('');
  useEffect(() => {
    const slug = activePlan?.slug ?? '';
    if (!slug || readGit.current === gitKey) return;
    readGit.current = gitKey;
    let cancelled = false;
    void window.mvpfy
      .featureGitStatus(
        project.localPath,
        project.repos.map((r) => r.dir),
        `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`,
        slug,
        `mvpfy/${slug || 'feature'}`
      )
      .then((rows) => {
        if (!cancelled) setFeatureGit(rows);
      })
      .catch(() => {
        if (!cancelled) setFeatureGit([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gitKey, activePlan?.slug, project.id, project.localPath, project.repos]);

  // What GitHub says about the pull requests this feature raised. Read on
  // opening the feature and on request: everything interesting here happens
  // after mvpfy's part is finished — a check goes red an hour later, a review
  // arrives overnight, it merges while nobody is looking.
  // Stamped with the urls it answered for, so switching features shows nothing
  // rather than the last feature's pull requests while the next load runs.
  const [prAnswer, setPrAnswer] = useState<{
    key: string;
    nonce: number;
    rows: PullRequestState[];
  }>({ key: '', nonce: -1, rows: [] });
  const prUrlKey = (activePlan?.plan?.prUrls ?? []).join('|');
  const [prNonce, setPrNonce] = useState(0);
  const refreshPrStates = useCallback(() => setPrNonce((n) => n + 1), []);
  useEffect(() => {
    if (!prUrlKey) return;
    let cancelled = false;
    void window.mvpfy
      .pullRequestStates(prUrlKey.split('|'))
      .then((rows) => {
        if (!cancelled) setPrAnswer({ key: prUrlKey, nonce: prNonce, rows });
      })
      .catch(() => {
        if (!cancelled) setPrAnswer({ key: prUrlKey, nonce: prNonce, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [prUrlKey, prNonce]);
  const prStates = prAnswer.key === prUrlKey ? prAnswer.rows : [];
  // Derived rather than set in the effect: an answer that is not for this
  // feature's urls, or is one Refresh behind, means gh is still being asked.
  // The rows already on screen stay up meanwhile — a refresh that blanked them
  // would say less than the stale ones did.
  const prStatesLoading = prAnswer.key !== prUrlKey || prAnswer.nonce !== prNonce;

  const commitFeatureWork = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) throw new Error('Open a feature first.');
      const slug = active.slug;
      const runId = makeRunId('commit-work');
      runsApi.track({ runId, kind: 'sync', projectId: project.id, planSlug: slug });
      await window.mvpfy.commitFeatureWork(
        runId,
        project.localPath,
        project.repos.map((r) => r.dir),
        `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`,
        slug,
        `mvpfy/${slug || 'feature'}`,
        `${active.plan.spec.feature || slug}: work left uncommitted by an earlier run`
      );
    });

  /**
   * Bring this feature up to date with the trunk.
   *
   * A feature branches once and then stands still while the trunk moves: by
   * the time it is tested, what it is being tested on is the product as it was
   * weeks ago, and the conflicts it will hit at the pull request are all still
   * ahead of it. Syncing the workspace already does this for the feature being
   * tested, as part of the same sequence; this is the same merge for any
   * feature, on its own, without putting anything down first.
   *
   * It happens in the feature's own checkout, so the workspace is untouched —
   * unless the workspace is standing on this very feature, in which case it is
   * detached at the commit from before the merge and has to be moved to the
   * new tip, or what is running is still the old code.
   */
  // Said once it is true and kept for as long as the feature is open: an
  // update that did everything asked of it used to end in silence, and silence
  // is what a failure looks like too.
  const [updated, setUpdated] = useState<{ slug: string; at: number } | null>(null);
  const justUpdated = updated !== null && updated.slug === (activePlan?.slug ?? '');

  const projectKey = () =>
    `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`;

  /**
   * Put the workspace back on the feature it is testing, after its branch has
   * moved. The workspace copy is detached at a commit, so a merge leaves it
   * standing on the code as it was before — what is running would still be the
   * old product with the log saying it was updated.
   */
  const restandIfTesting = async (slug: string) => {
    if (project.testingSlug !== slug) return;
    await window.mvpfy.checkoutFeature(
      project.localPath,
      project.repos.map((r) => r.dir),
      slug
    );
  };

  /**
   * Send the updated branch to the remote, where the remote already has it.
   *
   * An open pull request is the reason this matters: until the merge reaches
   * GitHub, the pull request still shows the feature as it was before the trunk
   * went into it, and its checks were run against a merge that no longer
   * describes anything. Only the feature's own branch is ever pushed, and only
   * when the remote has it already — publishing a branch is what raising the
   * pull request does, not something an update does behind your back.
   */
  const pushUpdatedBranch = async (slug: string) => {
    const runId = makeRunId('pushbranch');
    runsApi.track({ runId, kind: 'sync', projectId: project.id, planSlug: slug });
    await window.mvpfy.pushFeatureBranch(
      runId,
      project.localPath,
      project.repos.map((r) => r.dir),
      `mvpfy/${slug || 'feature'}`
    );
    await runsApi.completed(runId);
  };

  /**
   * Take a merge that stopped on conflicts as far as it can honestly go.
   *
   * The agent rewrites the conflicted files in the feature's own checkouts —
   * both sides are code, and the person who owns this screen reads plain
   * language. Then git is asked, not the agent: mvpfy commits only when nothing
   * is left unmerged and no file still holds a conflict marker, and only onto
   * the feature's own branch. Anything else abandons the merge, which puts the
   * feature back to exactly what it was.
   *
   * The trunk is never checked out, committed to, moved or pushed by any of
   * this. A conflict is resolved on the feature's side, where it belongs: the
   * trunk is what the rest of the team is working from, and it ends this
   * operation byte for byte as it started it.
   */
  const resolveOpenMerge = async (slug: string, featureName: string): Promise<string | null> => {
    const dirs = project.repos.map((r) => r.dir);
    const key = projectKey();
    const branch = `mvpfy/${slug || 'feature'}`;
    const trunk = featureGit.find((r) => r.trunk)?.trunk ?? 'the trunk';
    const shortName = (dir: string) => dir.split(/[/\\]/).pop() ?? dir;
    const open = await window.mvpfy.featureConflicts(project.localPath, dirs, key, slug);
    if (open.length === 0) return null;

    if (open.some((c) => c.files.length > 0)) {
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      // Returned rather than thrown: repositories that merged cleanly are
      // already committed, and they still have to be pushed.
      if (authProblem) return authProblem;
      const handle = await startResolveMergeRun(
        project,
        state.settings,
        slug,
        featureName,
        trunk,
        open,
        sessionFor(slug, false)
      );
      runsApi.track(handle);
      await runsApi.completed(handle.runId);
    }

    // git's account of it, not the agent's: a run can exit zero having left
    // half the markers in place.
    const left = await window.mvpfy.featureConflicts(project.localPath, dirs, key, slug);
    const unresolved = left.filter((c) => c.files.length > 0).map((c) => shortName(c.repo));
    // Every repository takes its own path here: the ones whose resolution git
    // agrees with are committed, and the ones it does not are put back.
    const runId = makeRunId('mergedone');
    runsApi.track({ runId, kind: 'sync', projectId: project.id, planSlug: slug });
    await window.mvpfy.finishMerge(runId, project.localPath, dirs, key, slug, branch, 'commit');
    await runsApi.completed(runId);

    const after = await window.mvpfy.featureConflicts(project.localPath, dirs, key, slug);
    const stillOpen = after.map((c) => shortName(c.repo));
    if (stillOpen.length > 0) {
      return `A merge is still open in ${stillOpen.join(', ')} and could not be undone — see the log. Every other repository was finished.`;
    }
    if (unresolved.length > 0) {
      return `${trunk} and this feature changed the same code in ${unresolved.join(', ')} in ways that could not be combined, so the merge went back there — those repositories are exactly as they were, and nothing on ${trunk} was touched. Describe how the two should fit together in "Change this feature", then update again.`;
    }
    return null;
  };

  const updateFeature = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active) throw new Error('Open a feature first.');
      const slug = active.slug;
      const runId = makeRunId('merge');
      runsApi.track({ runId, kind: 'sync', projectId: project.id, planSlug: slug });
      await window.mvpfy.mergeTrunk(
        runId,
        project.localPath,
        project.repos.map((r) => r.dir),
        projectKey(),
        slug,
        `mvpfy/${slug || 'feature'}`,
        // Left open on purpose: what comes next is the thing that resolves it.
        'keep'
      );
      await runsApi.completed(runId);
      // One repository having trouble is not the others' problem: whatever did
      // merge is committed, pushed and stood on, and the trouble is reported
      // after all of that rather than instead of it.
      const problem = await resolveOpenMerge(slug, active.plan?.spec.feature || slug);
      await pushUpdatedBranch(slug);
      await restandIfTesting(slug);
      // Only when it is true of every repository: a feature that took the
      // trunk in one place and went back in another is not updated, and the
      // error says which.
      if (problem) throw new Error(problem);
      setUpdated({ slug, at: Date.now() });
    });

  const resolveMerge = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active) throw new Error('Open a feature first.');
      const problem = await resolveOpenMerge(active.slug, active.plan?.spec.feature || active.slug);
      await pushUpdatedBranch(active.slug);
      await restandIfTesting(active.slug);
      if (problem) throw new Error(problem);
    });

  const abandonMerge = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active) throw new Error('Open a feature first.');
      const slug = active.slug;
      const runId = makeRunId('mergeabort');
      runsApi.track({ runId, kind: 'sync', projectId: project.id, planSlug: slug });
      await window.mvpfy.finishMerge(
        runId,
        project.localPath,
        project.repos.map((r) => r.dir),
        projectKey(),
        slug,
        `mvpfy/${slug || 'feature'}`,
        'abort'
      );
      await runsApi.completed(runId);
      await restandIfTesting(slug);
    });

  // What a stopped run left behind, in whatever shape it left it: a story
  // halfway through, or work in the checkout belonging to no story at all —
  // a change that ran out of allowance leaves the second and not the first.
  // One answer, because there is one button.
  const lastStoryRun = storyRuns.filter((r) => !r.running).pop();
  // About the feature on screen, not the project: another feature implementing
  // elsewhere says nothing about whether this one was left half-finished, and
  // reading it project-wide hid a stranded feature for as long as any other
  // one was running.
  const thisFeatureRunning = storyRunningFor(activePlan?.slug ?? '', storyRuns);
  const strandedStory = thisFeatureRunning
    ? null
    : (activePlan?.plan?.stories.find((st) => st.lane === 'coding')?.code ?? null);
  const strandedFiles = thisFeatureRunning
    ? 0
    : featureGit.reduce((n, r) => n + r.uncommitted.length, 0);
  const stranded: StrandedFeature | null =
    strandedStory || strandedFiles > 0
      ? {
          story: strandedStory,
          files: strandedFiles,
          quota: quotaExhausted(lastStoryRun?.log),
        }
      : null;

  /**
   * Carry on from wherever the feature stopped.
   *
   * One action for every way a run can leave a feature part-way, because from
   * the outside they are the same situation: something was being built, it
   * stopped, and the work is still in the checkout. Which of the three it
   * actually is should not be the builder's problem to tell apart.
   */
  const continueFeature = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) throw new Error('Open a feature first.');
      // A story halfway through is resumed, and the run-all chain is armed so
      // the rest of the feature follows it rather than stopping at one story.
      if (strandedStory) {
        const slug = active.slug;
        setRunAll((prev) => (prev.includes(slug) ? prev : [...prev, slug]));
        await implementStory(strandedStory, true, slug);
        return;
      }
      // Work in the checkout belonging to no story: a change that stopped
      // before it committed. Finishing it is the same run that made it.
      if (strandedFiles > 0) {
        await changeFeature(
          'A previous run stopped before it finished and left its work in this checkout, ' +
            'uncommitted. Read what is there first — git status and git diff — work out what ' +
            'it was in the middle of, finish that, and commit it. Do not undo it and do not ' +
            'start something else.'
        );
        return;
      }
      // Nothing half-done, so continuing means the next story.
      await implementFeature();
    });

  /**
   * Remove a feature's board.
   *
   * Everything mvpfy wrote about the feature goes; nothing git holds does. The
   * branch and its commits stay, and so does anything already on GitHub —
   * deleting a card is not a decision to throw work away, and somebody who
   * deletes the wrong one should lose an afternoon of planning at worst.
   */
  const deleteFeature = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active) throw new Error('Open a feature first.');
      const slug = active.slug;
      if (!slug) throw new Error('This feature has no name to remove it by.');
      if (anyStoryRunning || projectRuns.some((r) => r.running && r.handle.planSlug === slug)) {
        throw new Error('Something is still running for this feature — stop it first.');
      }
      const dirs = project.repos.map((r) => r.dir);
      const projectKey = `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`;
      // Put the workspace back on its trunk first: the checkout is detached at
      // a commit of this feature, and removing the board while the app is
      // running its code leaves somebody testing a feature that is gone.
      if ((project.testingSlug ?? null) === slug) {
        await window.mvpfy.checkoutFeature(project.localPath, dirs, null);
      }
      await window.mvpfy.worktree(
        project.localPath,
        dirs,
        projectKey,
        slug,
        `mvpfy/${slug}`,
        'remove'
      );
      await window.mvpfy.deleteFeature(project.localPath, configDirFor(project.mode), slug);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => {
          if (p.id !== project.id) return p;
          const drop = <T>(rec: Record<string, T> | undefined) => {
            if (!rec) return rec;
            const next = { ...rec };
            delete next[slug];
            return next;
          };
          return {
            ...p,
            planSlugs: (p.planSlugs ?? []).filter((s) => s !== slug),
            featureSessions: drop(p.featureSessions),
            featureAsks: drop(p.featureAsks),
            feature1Refs: drop(p.feature1Refs),
            testingSlug: p.testingSlug === slug ? null : p.testingSlug,
          };
        }),
      }));
      setSelectedPlanSlug(null);
      refreshFiles();
    });

  const writeDesign = async (next: { images: string[]; links: string[] }) => {
    const active = activePlan;
    if (!active?.plan) throw new Error('Open a feature first.');
    await writePlan(active.slug, { ...active.plan, design: next });
  };

  const addDesign = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) throw new Error('Open a feature first.');
      const picked = await window.mvpfy.pickImages();
      if (picked.length === 0) return;
      const added = await window.mvpfy.addDesign(
        project.localPath,
        configDirFor(project.mode),
        active.slug,
        picked
      );
      const design = active.plan.design ?? { images: [], links: [] };
      await writeDesign({ ...design, images: [...design.images, ...added] });
    });

  const removeDesign = (name: string) =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) return;
      await window.mvpfy.removeDesign(
        project.localPath,
        configDirFor(project.mode),
        active.slug,
        name
      );
      const design = active.plan.design ?? { images: [], links: [] };
      await writeDesign({ ...design, images: design.images.filter((i) => i !== name) });
    });

  const setDesignLinks = (links: string[]) =>
    guarded(async () => {
      const design = activePlan?.plan?.design ?? { images: [], links: [] };
      await writeDesign({ ...design, links: links.map((l) => l.trim()).filter(Boolean) });
    });

  // The inverse of pullFeature: a feature planned here is filed in Feature1.
  // Only for a feature that came from here — one that was pulled already has a
  // Feature1 record, and creating a second would split its history in two.
  const pushFeature = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) throw new Error('Open a feature first.');
      if (active.plan.feature1FeatureRef) {
        throw new Error('This feature is already in Feature1.');
      }
      if (active.plan.stories.length === 0) {
        throw new Error('Approve the plan and generate its stories before pushing it up.');
      }
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const mcp = await feature1Mcp();
      const handle = await startPushFeatureRun(
        project,
        state.settings,
        active.slug,
        project.featureAsks?.[active.slug] ?? '',
        mcp,
        sessionFor(active.slug, false)
      );
      runsApi.track(handle);
    });

  // The other direction of the same link: the feature is there, and what has
  // happened here since needs to reach it. Only for a feature that was filed —
  // one that was pulled from Feature1 is already theirs to change.
  const syncFeature = () =>
    guarded(async () => {
      const active = activePlan;
      if (!active?.plan) throw new Error('Open a feature first.');
      const ref = active.plan.feature1FeatureRef;
      if (!ref) throw new Error('This feature is not in Feature1 yet — push it first.');
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      const mcp = await feature1Mcp();
      const handle = await startSyncFeatureRun(
        project,
        state.settings,
        active.slug,
        ref,
        project.featureAsks?.[active.slug] ?? '',
        mcp,
        sessionFor(active.slug, false)
      );
      runsApi.track(handle);
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
        text,
        sessionFor(activePlan.slug, false)
      );
      runsApi.track(handle);
      // A refinement is part of what was asked for, not a replacement of it:
      // the description in Feature1 should read like the whole request.
      const slug = activePlan.slug;
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id
            ? {
                ...p,
                featureAsks: {
                  ...(p.featureAsks ?? {}),
                  [slug]: [p.featureAsks?.[slug], text].filter(Boolean).join('\n\nThen: '),
                },
              }
            : p
        ),
      }));
    });

  const approvePlan = () =>
    guarded(async () => {
      if (!activePlan?.plan) return;
      await writePlan(activePlan.slug, { ...activePlan.plan, approved: true });
    });

  /**
   * `forSlug` names the feature, rather than this reading whichever feature
   * happens to be open. With one feature running that was the same thing; with
   * several it is not, and the chain that starts the next story would have put
   * it in whatever feature the builder had clicked on meanwhile.
   */
  const implementStory = (code: string, continuing = false, forSlug?: string) =>
    guarded(async () => {
      const slug = forSlug ?? activePlan?.slug ?? '';
      const plan = plans.find((pl) => pl.slug === slug)?.plan;
      const story = plan?.stories.find((s) => s.code === code);
      if (!plan || !story) throw new Error(`Story ${code} not found in the plan`);
      if (!plan.approved) throw new Error('Agree with the PRD first — then the board opens');
      if (story.lane !== 'todo' && story.lane !== 'coding') {
        throw new Error(`${code} is in ${story.lane} — drag it back to To Do to re-implement`);
      }
      // Per feature, not per project. Two features implement in two checkouts,
      // on two branches, in two conversations — the reason this was ever one
      // at a time stopped being true when each feature got its own worktree.
      const why = cannotStartReason(slug, storyRuns);
      if (why) throw new Error(why);
      if (planBlocked) {
        throw new Error('Wait for the current environment run to finish first');
      }
      // Ship lands a PR at Testing, so the agent AND gh must be signed in.
      const authProblem = await preflightAuth(state.settings.defaultAgent, true);
      if (authProblem) throw new Error(authProblem);
      // Implementing moves the branch, and the workspace is detached at a
      // commit — it would silently fall behind and keep claiming to be this
      // feature. So testing stops here and is picked up again afterwards,
      // when there is a settled commit to pick up.
      if ((project.testingSlug ?? null) === slug) {
        await window.mvpfy.checkoutFeature(
          project.localPath,
          project.repos.map((r) => r.dir),
          null
        );
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, testingSlug: null } : p
          ),
        }));
      }
      if (story.lane === 'todo') {
        await writePlan(slug, {
          ...plan,
          stories: plan.stories.map((s) =>
            s.code === code ? { ...s, lane: 'coding' as StoryLane } : s
          ),
        });
      }
      // A Feature1-sourced story also drives the Feature1 workflow over MCP,
      // so register the tenant's MCP server for the run and pass the link.
      const mcp = story.feature1StoryId ? await feature1Mcp() : undefined;
      // The feature's own checkouts, created on first use. A failure here is
      // not fatal: the run falls back to the workspace, which is how it worked
      // before worktrees existed.
      const branch = `mvpfy/${slug || 'feature'}`;
      const trees = await window.mvpfy.worktree(
        project.localPath,
        project.repos.map((r) => r.dir),
        `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`,
        slug,
        branch,
        'add'
      );
      const handle = await startPlanStoryRun(
        project,
        state.settings,
        slug,
        code,
        story.feedback,
        story.feature1StoryId,
        mcp,
        sessionFor(slug, false),
        trees.ok ? (trees.paths ?? {}) : {},
        continuing,
        plan.design
      );
      runsApi.track(handle);
    });

  /**
   * A change to the feature's code, asked for in words.
   *
   * Everything implementStory does about *where* work happens applies equally:
   * the feature's own checkouts, and testing released first, because the
   * workspace is detached at a commit and a new one would leave it silently
   * behind while still claiming to be this feature.
   */
  const changeFeature = (instruction: string) =>
    guarded(async () => {
      const text = instruction.trim();
      if (!text) return;
      const slug = activePlan?.slug ?? '';
      const plan = activePlan?.plan;
      if (!plan) throw new Error('Open a feature first.');
      if (!plan.approved)
        throw new Error('Agree with the PRD first — then the code is yours to change');
      if (anyStoryRunning) {
        throw new Error(
          'A story is being implemented — wait for it, so two runs do not write the same checkout'
        );
      }
      if (planBlocked) throw new Error('Wait for the current environment run to finish first');
      // No gh needed: this commits and stops. The pull request is raised once,
      // for the whole feature, when the builder says it is finished.
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      if ((project.testingSlug ?? null) === slug) {
        await window.mvpfy.checkoutFeature(
          project.localPath,
          project.repos.map((r) => r.dir),
          null
        );
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, testingSlug: null } : p
          ),
        }));
      }
      const branch = `mvpfy/${slug || 'feature'}`;
      const trees = await window.mvpfy.worktree(
        project.localPath,
        project.repos.map((r) => r.dir),
        `${project.localPath.split(/[/\\]/).pop() ?? 'project'}-${project.id.slice(0, 6)}`,
        slug,
        branch,
        'add'
      );
      const handle = await startFeatureChangeRun(
        project,
        state.settings,
        slug,
        plan.spec.feature || slug,
        text,
        sessionFor(slug, false),
        trees.ok ? (trees.paths ?? {}) : {}
      );
      runsApi.track(handle);
    });

  // Published for the lost-conversation retry above, which is declared before
  // implementStory exists. Assigned in an effect: writing a ref during render
  // is the rule this file already had to be fixed for once.
  useEffect(() => {
    implementStoryRef.current = implementStory;
  });

  /**
   * Work through the feature's remaining stories in order.
   *
   * Chained rather than run as one large agent turn: the board keeps moving —
   * each story visibly goes Coding then Testing — a failure stops where it
   * happened with the earlier work already landed, and sending a story back
   * with feedback still works, because each is still its own run. The feature
   * shares one conversation, so nothing is re-read between them.
   */
  const implementFeature = (forSlug?: string) =>
    guarded(async () => {
      const active = forSlug ? (plans.find((pl) => pl.slug === forSlug) ?? null) : activePlan;
      // A story left in Coding is one whose run stopped part-way — the
      // allowance ran out, or it was interrupted. Picking only from To Do meant
      // the feature refused to go on at all, with the half-finished story
      // sitting there and no way to resume it.
      const stuck = active?.plan?.stories.find((st) => st.lane === 'coding');
      const next = stuck ?? active?.plan?.stories.find((st) => st.lane === 'todo');
      if (!active || !next) {
        throw new Error('Every story in this feature has been accepted already');
      }
      const slug = active.slug;
      setRunAll((prev) => (prev.includes(slug) ? prev : [...prev, slug]));
      // implementStory reports its own failures; the chain below picks up from
      // whatever it leaves behind.
      await implementStory(next.code, Boolean(stuck), slug);
    });

  /**
   * Work through several features, as many at once as the limit allows and the
   * rest in turn.
   *
   * Picking features one screen at a time was the only way to start more than
   * one, which made a capability nobody could see: the board is where somebody
   * decides what this week looks like, so it is where the work starts.
   */
  const implementFeatures = (slugs: string[]) =>
    guarded(async () => {
      const ready = slugs.filter((slug) => {
        const plan = plans.find((pl) => pl.slug === slug)?.plan;
        return (
          plan?.approved &&
          plan.stories.some((st) => st.lane === 'todo' || st.lane === 'coding') &&
          !storyRunningFor(slug, storyRuns)
        );
      });
      if (ready.length === 0) {
        throw new Error('Nothing to implement in what you picked — agreed PRDs with stories left.');
      }
      // Everything goes in the queue and the pump below starts what it can, so
      // one feature and six take the same path and the limit lives in one place.
      setQueued((prev) => [...prev, ...ready.filter((slug) => !prev.includes(slug))]);
    });

  // Start queued features as room appears. Room is read from the runs
  // themselves rather than from what this hook believes it started, so a run
  // that failed to start, or one started from a feature's own screen, is
  // counted the same way.
  // Dispatched but not yet visible as a run: between asking for a feature and
  // its first story appearing in the runs there are renders where it is in
  // neither list, and without this it would be asked for again in each of them.
  const starting = useRef(new Set<string>());
  useEffect(() => {
    if (queued.length === 0) return;
    const running = featuresRunning(storyRuns);
    if (running.length + starting.current.size >= MAX_FEATURES_AT_ONCE) return;
    const next = queued.find((slug) => !running.includes(slug) && !starting.current.has(slug));
    if (!next) return;
    starting.current.add(next);
    queueMicrotask(() => {
      setQueued((prev) => prev.filter((slug) => slug !== next));
      void implementFeature(next).finally(() => starting.current.delete(next));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, storyRuns]);

  /**
   * The moments worth interrupting someone for.
   *
   * Everything here runs for a long time with nobody watching — that is the
   * point of it — so the end of the waiting has to reach somebody who walked
   * away. Said once per run, and only while mvpfy is not the window they are
   * looking at; the main process decides that, because only it can know.
   */
  const announced = useRef(new Set<string>());
  const [quotaWait, setQuotaWait] = useState<{
    slug: string;
    story: string | null;
    attempt: number;
    at: Date;
  } | null>(null);

  useEffect(() => {
    for (const run of projectRuns) {
      if (run.running) continue;
      const kind = run.handle.kind;
      // A pull from Feature1 writes a spec, so it arrives as a spec run — what
      // tells them apart is whether the plan it produced carries a Feature1
      // reference. Both end a wait, and say so differently.
      if (kind !== 'plan-story' && kind !== 'plan-spec' && kind !== 'push-feature') continue;
      if (announced.current.has(run.handle.runId)) continue;
      const slug = run.handle.planSlug ?? '';
      const plan = plans.find((pl) => pl.slug === slug)?.plan;
      const name = plan?.spec.feature || slug;

      if (kind === 'plan-spec' || kind === 'push-feature') {
        // A spec run that exited before its plan file landed has nothing to
        // announce yet; leaving it unmarked lets the next render try again.
        if (kind === 'plan-spec' && run.exitCode === 0 && !plan) continue;
        announced.current.add(run.handle.runId);
        if (run.exitCode !== 0) continue;
        void window.mvpfy.notify(
          kind === 'push-feature'
            ? featurePushed(name)
            : featurePulled(name, plan?.stories.length ?? 0, Boolean(plan?.feature1FeatureRef))
        );
        continue;
      }

      // A story run. Wait for its move out of Coding before reading the plan,
      // for the same reason the chain below does: the file is written by the
      // run that just ended, and announcing from a plan it has not landed in
      // yet says the wrong thing.
      const story = plan?.stories.find((st) => st.code === run.handle.storyId);
      if (plan && story?.lane === 'coding' && run.exitCode === 0) continue;
      announced.current.add(run.handle.runId);

      if (run.exitCode !== 0 && quotaExhausted(run.log)) {
        const resetAt = quotaResetAt(run.log);
        const at = nextAttemptAt(
          new Date(),
          resetAt,
          quotaWait?.slug === slug ? quotaWait.attempt : 0
        );
        void window.mvpfy.notify(at ? quotaRanOut(name, resetAt) : quotaStillOut(name));
        queueMicrotask(() =>
          setQuotaWait(
            at
              ? {
                  slug,
                  story: run.handle.storyId ?? null,
                  attempt: (quotaWait?.slug === slug ? quotaWait.attempt : 0) + 1,
                  at,
                }
              : null
          )
        );
        continue;
      }
      if (run.exitCode !== 0) continue;
      // Nothing left to start in this feature: it is theirs to try now.
      const left = (plan?.stories ?? []).filter(
        (st) => st.lane === 'todo' || st.lane === 'coding'
      ).length;
      if (left === 0 && (plan?.stories.length ?? 0) > 0) {
        void window.mvpfy.notify(featureImplemented(name, plan?.stories.length ?? 0));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRuns, plans]);

  /**
   * Carry on when the allowance comes back.
   *
   * The one failure where doing nothing is the fix — and until now that hour
   * was the builder's to notice, remember and act on, so a feature sat
   * half-implemented until somebody opened the app and wondered why. Only
   * while mvpfy is open, which is said where it is offered.
   */
  useEffect(() => {
    if (!quotaWait) return;
    const timer = setTimeout(
      () => {
        const plan = plans.find((pl) => pl.slug === quotaWait.slug)?.plan;
        void window.mvpfy.notify(quotaBack(plan?.spec.feature || quotaWait.slug, quotaWait.story));
        setQuotaWait(null);
        void implementFeature(quotaWait.slug);
      },
      waitFor(new Date(), quotaWait.at)
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotaWait]);

  // Start the next story once the last one has landed in Testing. Waiting for
  // that move rather than for the run to exit keeps two writes to the same
  // plan file from racing each other.
  const chainedStories = useRef(new Set<string>());
  useEffect(() => {
    // One chain per feature being worked through. They advance independently:
    // a failure in one stops that feature where it happened and says nothing
    // about the others, which is the whole point of them being separate.
    for (const slug of runAll) {
      const run = storyRuns.find(
        (r) =>
          !r.running &&
          !chainedStories.current.has(r.handle.runId) &&
          (r.handle.planSlug ?? '') === slug
      );
      if (!run) continue;
      const plan = plans.find((pl) => pl.slug === slug)?.plan;
      const finished = plan?.stories.find((st) => st.code === run.handle.storyId);
      // Wait for the move into Testing before reading the plan again, so two
      // writes to the same file cannot race each other.
      if (!plan || finished?.lane === 'coding') continue;
      chainedStories.current.add(run.handle.runId);
      // A failure stops the chain where it happened: a later story usually
      // builds on an earlier one, and carrying on tends to produce a second
      // failure and a board nobody can read.
      const next = run.exitCode === 0 ? plan.stories.find((st) => st.lane === 'todo') : undefined;
      queueMicrotask(() => {
        if (next) void implementStory(next.code, false, slug);
        else setRunAll((prev) => prev.filter((s) => s !== slug));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyRuns, plans, runAll]);

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
    pullFeature,
    pushFeature,
    pushingFeature: projectRuns.some(
      (r) => r.handle.kind === 'push-feature' && r.running && r.handle.planSlug === activePlan?.slug
    ),
    syncFeature,
    syncingFeature: projectRuns.some(
      (r) => r.handle.kind === 'sync-feature' && r.running && r.handle.planSlug === activePlan?.slug
    ),
    refineSpec,
    markFeatureTested,
    raisePr,
    repairGitAuth,
    testFeature,
    preparingPreview,
    testingStale,
    approvePlan,
    implementStory,
    stranded,
    continueFeature,
    changeFeature,
    deleteFeature,
    addDesign,
    removeDesign,
    readDesign: (slug: string, name: string) =>
      window.mvpfy.readDesign(project.localPath, configDirFor(project.mode), slug, name),
    setDesignLinks,
    featureGit,
    prStates,
    prStatesLoading,
    refreshPrStates,
    commitFeatureWork,
    updateFeature,
    justUpdated,
    resolveMerge,
    abandonMerge,
    changingFeature: projectRuns.some(
      (r) =>
        r.handle.kind === 'feature-change' && r.running && r.handle.planSlug === activePlan?.slug
    ),
    implementFeature,
    runningFeatures: featuresRunning(storyRuns),
    cannotImplement: (slug: string) => cannotStartReason(slug, storyRuns),
    implementFeatures,
    queuedFeatures: queued,
    quotaWait: quotaWait ? { slug: quotaWait.slug, at: quotaWait.at } : null,
    moveStory,
  };
}
