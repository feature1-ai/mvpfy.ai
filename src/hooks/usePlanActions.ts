import { useCallback, useEffect, useRef, useState } from 'react';
import { RunSession, configDirFor, planFileFor, specFileFor } from '../../shared/types';
import {
  startPlanSpecRun,
  startPlanStoryRun,
  startPullFeatureRun,
  startPushFeatureRun,
  startSyncFeatureRun,
  startFeatureChangeRun,
  isAmbientRun,
  makeRunId,
  startGitAuthRun,
  startRaisePrRun,
} from '../lib/agentRunner';
import { Feature1McpClient, mcpBaseUrl } from '../lib/feature1Mcp';
import { preflightAuth } from '../lib/cliCheck';
import { redactSecrets } from '../lib/raiseFailure';
import { quotaExhausted } from '../lib/quota';
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
  /** Ask GitHub again — checks go red and reviews arrive after the fact. */
  refreshPrStates(): void;
  /** What each repository's checkout of the active feature is holding. */
  featureGit: FeatureRepoGit[];
  /** Commit whatever an agent left uncommitted in this feature's checkouts. */
  commitFeatureWork(): Promise<boolean>;
  /** Implement every remaining story in the active feature, in order. */
  implementFeature(): Promise<boolean>;
  /** The feature whose stories are being worked through, if any. */
  runningFeature: string | null;
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
  const [runAllSlug, setRunAllSlug] = useState<string | null>(null);

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
      if (slug !== null && anyStoryRunning) {
        throw new Error(
          'A story of this feature is being implemented — its code is still changing. Test it once that finishes.'
        );
      }
      const branch = slug === null ? null : `mvpfy/${slug || 'feature'}`;
      const res = await window.mvpfy.checkoutFeature(
        project.localPath,
        project.repos.map((r) => r.dir),
        branch
      );
      if (!res.ok) throw new Error(res.error || 'Could not switch the workspace to that branch');
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => (p.id === project.id ? { ...p, testingSlug: slug } : p)),
      }));
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
  const processedFailures = useRef(new Set<string>());
  useEffect(() => {
    for (const run of failedRuns) {
      if (processedFailures.current.has(run.handle.runId)) continue;
      processedFailures.current.add(run.handle.runId);
      forgetSession(run.handle.planSlug ?? '');
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
  const [prAnswer, setPrAnswer] = useState<{ key: string; rows: PullRequestState[] }>({
    key: '',
    rows: [],
  });
  const prUrlKey = (activePlan?.plan?.prUrls ?? []).join('|');
  const [prNonce, setPrNonce] = useState(0);
  const refreshPrStates = useCallback(() => setPrNonce((n) => n + 1), []);
  useEffect(() => {
    if (!prUrlKey) return;
    let cancelled = false;
    void window.mvpfy
      .pullRequestStates(prUrlKey.split('|'))
      .then((rows) => {
        if (!cancelled) setPrAnswer({ key: prUrlKey, rows });
      })
      .catch(() => {
        if (!cancelled) setPrAnswer({ key: prUrlKey, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [prUrlKey, prNonce]);
  const prStates = prAnswer.key === prUrlKey ? prAnswer.rows : [];

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

  // What a stopped run left behind, in whatever shape it left it: a story
  // halfway through, or work in the checkout belonging to no story at all —
  // a change that ran out of allowance leaves the second and not the first.
  // One answer, because there is one button.
  const lastStoryRun = storyRuns.filter((r) => !r.running).pop();
  const strandedStory = anyStoryRunning
    ? null
    : (activePlan?.plan?.stories.find((st) => st.lane === 'coding')?.code ?? null);
  const strandedFiles = anyStoryRunning
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
        setRunAllSlug(active.slug);
        await implementStory(strandedStory, true);
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

  const implementStory = (code: string, continuing = false) =>
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
          'A story is already being implemented — one at a time, so two runs do not write the same checkout'
        );
      }
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

  /**
   * Work through the feature's remaining stories in order.
   *
   * Chained rather than run as one large agent turn: the board keeps moving —
   * each story visibly goes Coding then Testing — a failure stops where it
   * happened with the earlier work already landed, and sending a story back
   * with feedback still works, because each is still its own run. The feature
   * shares one conversation, so nothing is re-read between them.
   */
  const implementFeature = () =>
    guarded(async () => {
      const active = activePlan;
      // A story left in Coding is one whose run stopped part-way — the
      // allowance ran out, or it was interrupted. Picking only from To Do meant
      // the feature refused to go on at all, with the half-finished story
      // sitting there and no way to resume it.
      const stuck = active?.plan?.stories.find((st) => st.lane === 'coding');
      const next = stuck ?? active?.plan?.stories.find((st) => st.lane === 'todo');
      if (!active || !next) {
        throw new Error('Every story in this feature has been accepted already');
      }
      setRunAllSlug(active.slug);
      // implementStory reports its own failures; the chain below picks up from
      // whatever it leaves behind.
      await implementStory(next.code, Boolean(stuck));
    });

  // Start the next story once the last one has landed in Testing. Waiting for
  // that move rather than for the run to exit keeps two writes to the same
  // plan file from racing each other.
  const chainedStories = useRef(new Set<string>());
  useEffect(() => {
    if (!runAllSlug) return;
    const run = storyRuns.find(
      (r) =>
        !r.running &&
        !chainedStories.current.has(r.handle.runId) &&
        (r.handle.planSlug ?? '') === runAllSlug
    );
    if (!run) return;
    const plan = plans.find((pl) => pl.slug === runAllSlug)?.plan;
    const finished = plan?.stories.find((st) => st.code === run.handle.storyId);
    // Wait for the move into Testing before reading the plan again, so two
    // writes to the same file cannot race each other.
    if (!plan || finished?.lane === 'coding') return;
    chainedStories.current.add(run.handle.runId);
    // A failure stops the chain where it happened: a later story usually
    // builds on an earlier one, and carrying on tends to produce a second
    // failure and a board nobody can read.
    const next = run.exitCode === 0 ? plan.stories.find((st) => st.lane === 'todo') : undefined;
    queueMicrotask(() => {
      if (next) void implementStory(next.code);
      else setRunAllSlug(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyRuns, plans, runAllSlug]);

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
    refreshPrStates,
    commitFeatureWork,
    changingFeature: projectRuns.some(
      (r) =>
        r.handle.kind === 'feature-change' && r.running && r.handle.planSlug === activePlan?.slug
    ),
    implementFeature,
    runningFeature: runAllSlug,
    moveStory,
  };
}
