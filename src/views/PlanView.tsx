import { useState } from 'react';
import type { ReactNode } from 'react';
import { FeaturePlan, ProjectController } from '../hooks/useProjectController';
import {
  LANES,
  LANE_LABELS,
  PlanStory,
  ProjectPlan,
  SpecItem,
  StoryLane,
  canMove,
  featureLane,
  uncoveredItems,
} from '../lib/plan';
import { Feature1Feature } from '../lib/feature1Mcp';
import Feature1LoginPrompt from './Feature1LoginPrompt';
import ReadinessPanel from './ReadinessPanel';

interface Props {
  c: ProjectController;
  onOpenTab: (tab: 'app' | 'logs') => void;
}

/**
 * Plan tab: one board per planned feature (Todo → Coding → Testing → Done),
 * under a toolbar that hops between features, returns to planning home, and
 * re-reads the files from disk. Planning a new feature is allowed while
 * another feature's story is still being implemented.
 */
export default function PlanView({ c, onOpenTab }: Props) {
  const [draft, setDraft] = useState('');
  const [refine, setRefine] = useState('');
  const [dragCode, setDragCode] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<StoryLane | null>(null);
  const [bounce, setBounce] = useState<{ code: string; feedback: string } | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [planMode, setPlanMode] = useState<'describe' | 'feature1'>('describe');
  const [featureRef, setFeatureRef] = useState('');

  const login = c.feature1Login;
  const sync = c.feature1Sync;
  const plans = c.plans;
  const active = c.activePlan;
  const plan = active?.plan ?? null;

  // Launch readiness is one of the features, not a place of its own: mvpfy
  // starts it with the project, so on a fresh product it is the only thing
  // there is to look at. Once real features exist, it is one chip away.
  const [pick, setPick] = useState<'readiness' | 'plans' | null>(null);
  // null means the feature board. Opening a feature drills into its stories.
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const readinessKnown = c.readinessVerdict !== null || c.readinessRunning;
  const showReadiness =
    pick === 'readiness' || (pick === null && readinessKnown && plans.length === 0);

  // Planning home — the "Plan a feature" screen. Reachable from anywhere in
  // the tab rather than only on the way in, so a board is never a dead end.
  const goPlanHome = () => {
    setPick('plans');
    setCreatingNew(true);
    setBounce(null);
  };

  const openFeature = (slug: string) => {
    setPick('plans');
    setCreatingNew(false);
    setBounce(null);
    setOpenSlug(slug);
    c.setActivePlanSlug(slug);
  };

  // A synced feature already on a board is one of the chips above; only the
  // ones with nothing behind them yet need an offer to pull.
  const pulledRefs = new Set(
    plans.map((f) => (f.plan?.feature1FeatureRef ?? '').toLowerCase()).filter(Boolean)
  );
  const assignedNotPulled = sync.features.filter(
    (f) => !pulledRefs.has(f.code.toLowerCase()) && !pulledRefs.has(f.id.toLowerCase())
  );

  const toolbar = (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      {readinessKnown && (
        <ReadinessChip
          c={c}
          selected={showReadiness}
          onClick={() => {
            setPick('readiness');
            setCreatingNew(false);
          }}
        />
      )}
      {(openSlug !== null || showReadiness || creatingNew) && (
        <button
          onClick={() => {
            setOpenSlug(null);
            setPick('plans');
            setCreatingNew(false);
          }}
          className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs text-body transition-colors hover:border-muted"
        >
          ← All features
        </button>
      )}
      {openSlug !== null &&
        plans.map((f) => (
          <FeatureChip
            key={f.slug}
            feature={f}
            selected={f.slug === active?.slug}
            onClick={() => openFeature(f.slug)}
          />
        ))}
      {/* Not connected: Sync leads to the sign-in rather than an error. */}
      <button
        onClick={() => {
          if (!c.tenantConnected) {
            goPlanHome();
            setPlanMode('feature1');
            return;
          }
          void sync.sync();
        }}
        disabled={sync.syncing}
        title="Fetch the Feature1 features assigned to you"
        className="ml-auto h-7 rounded-full border border-line bg-surface px-3 text-xs text-body transition-colors hover:border-muted disabled:opacity-60"
      >
        {sync.syncing ? 'Syncing…' : '⇅ Sync Feature1'}
      </button>
      <button
        onClick={c.refreshFiles}
        title="Re-read plans, stories and launch readiness from disk"
        className="h-7 rounded-full border border-line bg-surface px-3 text-xs text-muted transition-colors hover:border-muted hover:text-body"
      >
        ↻ Refresh
      </button>
      {(sync.error || assignedNotPulled.length > 0 || sync.syncedAt) && (
        <div className="w-full">
          {sync.error && <p className="mt-1 text-[12px] text-danger">{sync.error}</p>}
          {!sync.error && assignedNotPulled.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] text-muted">Assigned to you in Feature1:</span>
              {assignedNotPulled.map((f) => (
                <AssignedFeaturePill
                  key={f.id}
                  feature={f}
                  pulling={c.planBlocked}
                  onClick={() => {
                    setPick('plans');
                    setCreatingNew(false);
                    void c.pullFeature(f.code);
                  }}
                />
              ))}
            </div>
          )}
          {!sync.error && sync.syncedAt && assignedNotPulled.length === 0 && (
            <p className="mt-1 text-[11.5px] text-muted">
              {sync.features.length === 0
                ? 'Nothing is assigned to you in Feature1.'
                : 'Every feature assigned to you is already on a board.'}
            </p>
          )}
        </div>
      )}
    </div>
  );

  if (showReadiness) {
    return (
      <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-7">
        {toolbar}
        <div className="mx-auto w-full max-w-[880px]">
          <ReadinessPanel c={c} onOpenTab={onOpenTab} />
        </div>
      </div>
    );
  }

  if (creatingNew || plans.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-7">
        {toolbar}
        <div className={`mx-auto w-full max-w-[640px] ${plans.length === 0 ? 'pt-14' : 'pt-4'}`}>
          <h1 className="mb-2 text-[26px] font-semibold tracking-[-0.02em]">Plan a feature</h1>
          <p className="mb-7 text-sm leading-relaxed text-body [text-wrap:pretty]">
            Describe what you want to build. mvpfy studies the product, writes a minimal spec —
            problem, scope, flows, requirements — and breaks it into user stories you can run one by
            one on the board.
            {plans.length > 0 &&
              ' Each feature gets its own board — planning this one never touches the others.'}
          </p>
          {/* Shown whether or not Feature1 is connected: hiding it meant the
              only people who could find it were those who had already set it
              up in Settings. Not connected simply leads to signing in. */}
          <div className="mb-4 inline-flex rounded-lg border border-line p-0.5 text-[13px]">
            <button
              onClick={() => setPlanMode('describe')}
              className={`rounded-md px-3 py-1.5 ${planMode === 'describe' ? 'bg-surface font-medium' : 'text-muted'}`}
            >
              Describe it
            </button>
            <button
              onClick={() => setPlanMode('feature1')}
              className={`rounded-md px-3 py-1.5 ${planMode === 'feature1' ? 'bg-surface font-medium' : 'text-muted'}`}
            >
              Pull from Feature1
            </button>
          </div>

          {planMode === 'describe' ? (
            <>
              <label className="section-label mb-1.5 block">The feature</label>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  'e.g. Customers should be able to export any invoice as a PDF and email it to their accountant.'
                }
                rows={5}
                className="w-full resize-y rounded-lg border border-line bg-surface px-3.5 py-3 text-[13.5px] leading-relaxed outline-none placeholder:text-faint focus:border-muted"
              />
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => {
                    void c.generateSpec(draft).then((ok) => {
                      if (ok) {
                        setDraft('');
                        setCreatingNew(false);
                      }
                    });
                  }}
                  disabled={!draft.trim()}
                  className="btn-primary h-[38px] px-4 text-sm disabled:opacity-50"
                >
                  Generate spec &amp; stories
                </button>
                <span className="text-xs text-muted">~2–3 minutes, on your agent subscription</span>
              </div>
            </>
          ) : !c.tenantConnected ? (
            <Feature1LoginPrompt login={login} />
          ) : (
            <>
              <label className="section-label mb-1.5 block">Feature1 feature</label>
              <p className="mb-2 text-[13px] leading-relaxed text-body">
                <button onClick={() => void sync.sync()} className="text-go hover:underline">
                  Sync Feature1
                </button>{' '}
                to list what is assigned to you, or paste a feature code or id here. Either way
                mvpfy pulls its PRD, user stories and acceptance criteria in as a board —
                implementing a story here also updates it in Feature1.
              </p>
              <input
                value={featureRef}
                onChange={(e) => setFeatureRef(e.target.value)}
                placeholder="e.g. FEA-142 or the feature id"
                className="w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[13.5px] outline-none placeholder:text-faint focus:border-muted"
              />
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => {
                    void c.pullFeature(featureRef).then((ok) => {
                      if (ok) {
                        setFeatureRef('');
                        setCreatingNew(false);
                      }
                    });
                  }}
                  disabled={!featureRef.trim()}
                  className="btn-primary h-[38px] px-4 text-sm disabled:opacity-50"
                >
                  Pull feature
                </button>
                <span className="text-xs text-muted">~2–3 minutes, on your agent subscription</span>
              </div>
            </>
          )}
          {c.actionError && <p className="mt-3 text-[13px] text-danger">{c.actionError}</p>}
        </div>
      </div>
    );
  }

  // The board of features. Opening one drills into its stories; this is where
  // the tab lands, so the shape of the work is visible before any detail is.
  if (openSlug === null) {
    return (
      <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-7">
        {toolbar}
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Features</h1>
            <p className="mt-0.5 text-[13px] text-body">
              {plans.length} feature{plans.length === 1 ? '' : 's'} · open one to see its stories
            </p>
          </div>
          <button onClick={goPlanHome} className="btn-secondary h-8 px-3.5">
            Plan a feature
          </button>
        </div>
        <div className="grid grid-cols-2 items-start gap-4 min-[980px]:grid-cols-4">
          {LANES.map((lane) => {
            const inLane = plans.filter(
              (f) => featureLane(f.plan, f.generating || f.runningStory !== null) === lane
            );
            return (
              <div
                key={lane}
                className="min-h-[220px] rounded-[10px] border border-line bg-sunken p-2.5"
              >
                <div className="mb-2 flex items-baseline justify-between px-1">
                  <span className="section-label">{LANE_LABELS[lane]}</span>
                  <span className="font-mono text-[10.5px] text-faint">{inLane.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {inLane.map((f) => (
                    <FeatureCard key={f.slug} feature={f} onOpen={() => openFeature(f.slug)} />
                  ))}
                  {inLane.length === 0 && (
                    <p className="px-1 py-4 text-center text-[11.5px] text-faint">—</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11.5px] text-muted">
          A feature moves across as its stories do: Coding once any story has started, Testing once
          you have accepted them all, Done when its pull request is open.
        </p>
      </div>
    );
  }

  if (active?.generating) {
    return (
      <div className="flex h-full flex-col px-6 pt-7">
        <div className="mx-auto w-full max-w-[1120px]">{toolbar}</div>
        <Center>
          <span className="dot-pulse mb-3 inline-block h-[9px] w-[9px] rounded-full bg-go" />
          <h2 className="text-[15px] font-semibold">Writing the product spec…</h2>
          <p className="mt-1 max-w-[420px] text-[13px] text-body">
            Studying the product and drafting the spec and stories — a couple of minutes.{' '}
            <button onClick={() => onOpenTab('logs')} className="text-go hover:underline">
              Watch progress
            </button>
          </p>
        </Center>
      </div>
    );
  }

  if (!plan || !active) return null;

  const uncovered = uncoveredItems(plan);

  const specCard = (
    <section className="card mb-6 overflow-hidden">
      <div className="grid gap-x-8 gap-y-5 p-5 min-[800px]:grid-cols-2">
        <div>
          <div className="section-label mb-1.5">Problem</div>
          <p className="text-[13px] text-body">{plan.spec.overview.problem}</p>
          <div className="section-label mb-1.5 mt-4">Solution</div>
          <p className="text-[13px] text-body">{plan.spec.overview.summary}</p>
          <div className="section-label mb-1.5 mt-4">Target users</div>
          <p className="text-[13px] text-body">{plan.spec.overview.targetUsers}</p>
          <div className="section-label mb-1.5 mt-4">Success metrics</div>
          <ul className="grid gap-1 text-[13px] text-body">
            {plan.spec.overview.successMetrics.map((m, i) => (
              <li key={i}>· {m}</li>
            ))}
          </ul>
        </div>
        <div>
          <ItemList label="In scope" items={plan.spec.scope.inScope} uncovered={uncovered} />
          <ItemList label="Out of scope" items={plan.spec.scope.outOfScope} muted />
          <ItemList label="User flows" items={plan.spec.flows} uncovered={uncovered} />
          <ItemList
            label="Functional requirements"
            items={plan.spec.requirements.functional}
            uncovered={uncovered}
          />
          <ItemList
            label="Non-functional"
            items={plan.spec.requirements.nonFunctional}
            uncovered={uncovered}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-sunken px-5 py-3">
        <input
          value={refine}
          onChange={(e) => setRefine(e.target.value)}
          placeholder="Refine the spec — e.g. add bulk export to scope, split US-03 in two…"
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted"
        />
        <button
          onClick={() => {
            const text = refine;
            setRefine('');
            void c.refineSpec(text);
          }}
          disabled={active.generating || !refine.trim()}
          className="btn-primary h-8 px-3 text-xs disabled:opacity-50"
        >
          Refine
        </button>
      </div>
    </section>
  );

  // PRD review gate: the board only opens after the PM agrees with the spec.
  if (!plan.approved) {
    return (
      <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-7">
        {toolbar}
        <div className="mx-auto w-full max-w-[880px]">
          <div className="mb-5">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{plan.spec.feature}</h1>
            <p className="mt-0.5 text-[13px] text-body">
              Review the PRD below. Refine it in plain language until it reads right — the story
              board opens once you agree.
            </p>
          </div>
          {c.actionError && (
            <div className="mb-5 rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
              {c.actionError}
            </div>
          )}
          {specCard}
          <div className="flex items-center gap-3">
            <button
              onClick={() => void c.approvePlan()}
              className="btn-primary h-[38px] px-4 text-sm"
            >
              Agree — open the story board
            </button>
            <span className="text-xs text-muted">
              {plan.stories.length} user stor{plan.stories.length === 1 ? 'y is' : 'ies are'} ready
              behind this spec
            </span>
          </div>
        </div>
      </div>
    );
  }

  const byLane = (lane: StoryLane) => plan.stories.filter((s) => s.lane === lane);
  const done = byLane('done').length;

  function drop(lane: StoryLane) {
    setOverLane(null);
    if (!dragCode) return;
    const story = plan!.stories.find((s) => s.code === dragCode);
    setDragCode(null);
    if (!story || !canMove(story.lane, lane, 'user')) return;
    if (story.lane === 'testing' && lane === 'coding') {
      setBounce({ code: story.code, feedback: '' });
      return;
    }
    void c.moveStory(story.code, lane);
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-7">
      {toolbar}

      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{plan.spec.feature}</h1>
          <p className="mt-0.5 text-[13px] text-body">
            {plan.stories.length} stories · {done} done
            {uncovered.length > 0 && (
              <span className="text-warn-text">
                {' '}
                · {uncovered.length} spec item{uncovered.length === 1 ? '' : 's'} uncovered
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ImplementFeatureButton c={c} plan={plan} slug={active.slug} />
          <TestFeatureButton c={c} slug={active.slug} />
          <FeatureShipControls c={c} plan={plan} />
          <button onClick={() => setSpecOpen((v) => !v)} className="btn-secondary h-8 px-3.5">
            {specOpen ? 'Hide spec' : 'View spec'}
          </button>
        </div>
      </div>

      {c.actionError && (
        <div className="mb-5 rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
          {c.actionError}
        </div>
      )}

      {/* Spec (the agreed PRD, collapsible) */}
      {specOpen && specCard}

      {/* Board */}
      <div className="grid grid-cols-2 items-start gap-4 min-[980px]:grid-cols-4">
        {LANES.map((lane) => (
          <div
            key={lane}
            onDragOver={(e) => {
              e.preventDefault();
              setOverLane(lane);
            }}
            onDragLeave={() => setOverLane((v) => (v === lane ? null : v))}
            onDrop={() => drop(lane)}
            className={`min-h-[220px] rounded-[10px] border p-2.5 transition-colors ${
              overLane === lane ? 'border-go bg-go-bg' : 'border-line bg-sunken'
            }`}
          >
            <div className="mb-2 flex items-baseline justify-between px-1">
              <span className="section-label">{LANE_LABELS[lane]}</span>
              <span className="font-mono text-[10.5px] text-faint">{byLane(lane).length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {byLane(lane).map((story) => (
                <StoryCard
                  key={story.code}
                  story={story}
                  c={c}
                  testable={c.project.testingSlug === active.slug}
                  running={active.runningStory === story.code}
                  bounce={bounce}
                  setBounce={setBounce}
                  onDragStart={() => setDragCode(story.code)}
                  onOpenTab={onOpenTab}
                />
              ))}
              {byLane(lane).length === 0 && (
                <p className="px-1 py-4 text-center text-[11.5px] text-faint">
                  {lane === 'testing' ? 'Stories land here after coding' : '—'}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-muted">
        mvpfy moves stories through Coding into Testing. Only you can move a story to Done — test it
        in the App tab first. Drag a Testing story back to Coding to send it back with feedback.
        Every story in this feature commits to one branch, and one pull request opens for the whole
        feature once you have accepted them all. One story is implemented at a time across all
        features; planning new features is always allowed.
      </p>
    </div>
  );
}

/**
 * Work through the feature's remaining stories without being asked between
 * each one. Each still runs on its own, so the board keeps moving and a story
 * can still be sent back — this only removes the clicking.
 */
function ImplementFeatureButton({
  c,
  plan,
  slug,
}: {
  c: ProjectController;
  plan: ProjectPlan;
  slug: string;
}) {
  const remaining = plan.stories.filter((s) => s.lane === 'todo').length;
  const runningHere = c.runningFeature === slug;
  if (remaining === 0 && !runningHere) return null;
  return (
    <button
      onClick={() => void c.implementFeature()}
      disabled={c.anyStoryRunning || c.planBlocked || !plan.approved}
      title={
        plan.approved
          ? 'Implement the remaining stories one after another'
          : 'Agree with the PRD first'
      }
      className="btn-secondary h-8 px-3.5 disabled:opacity-50"
    >
      {runningHere && c.anyStoryRunning
        ? `Implementing… ${remaining} left`
        : `Implement ${remaining} ${remaining === 1 ? 'story' : 'stories'}`}
    </button>
  );
}

/**
 * Run the app from this feature's code. One working copy means one feature at
 * a time, so the button says which state it is in rather than leaving the
 * builder to guess which branch they are testing.
 */
function TestFeatureButton({ c, slug }: { c: ProjectController; slug: string }) {
  const live = c.project.testingSlug === slug;
  // Behind its own branch: the app is running this feature, but an earlier
  // round of it. Saying "Running this feature" there would be a lie of the
  // exact kind that gets a story accepted on work nobody saw.
  const stale = live && c.testingStale;
  return (
    <button
      onClick={() => void c.testFeature(stale ? slug : live ? null : slug)}
      disabled={c.busy}
      title={
        stale
          ? 'A story has landed since this was checked out — bring the app up to the latest commit'
          : live
            ? 'Put the workspace back on its default branch'
            : 'Check this feature out in the workspace, so the running app is this feature'
      }
      className={`h-8 rounded-md px-3 text-[13px] disabled:opacity-50 ${
        stale
          ? 'bg-warn-bg font-medium text-warn-text'
          : live
            ? 'bg-go-bg font-medium text-go'
            : 'btn-secondary'
      }`}
    >
      {stale
        ? 'Running an older version — update'
        : live
          ? '● Running this feature'
          : 'Test this feature'}
    </button>
  );
}

/**
 * Getting the finished feature out: the builder's gate over the whole set,
 * then its pull requests. Stories are still accepted one at a time — this is
 * the second gate, over what they add up to.
 */
function FeatureShipControls({ c, plan }: { c: ProjectController; plan: ProjectPlan }) {
  const prUrls = plan.prUrls ?? [];
  if (prUrls.length > 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {prUrls.map((url) => (
          <button
            key={url}
            onClick={() => c.openExternal(url)}
            className="max-w-[240px] truncate font-mono text-[11.5px] text-go hover:underline"
          >
            {url.replace('https://', '')}
          </button>
        ))}
      </div>
    );
  }

  const done = plan.stories.filter((s) => s.lane === 'done').length;
  const allDone = plan.stories.length > 0 && done === plan.stories.length;

  // Every story accepted: the feature is ready to go out, so that is the
  // primary action. Before then it stays available but quiet — a builder may
  // want a reviewer on a half-finished feature, and that is their call.
  return allDone ? (
    <button
      onClick={() => {
        void c.markFeatureTested();
        void c.raisePr();
      }}
      disabled={c.busy}
      title="Push the feature branch and open a pull request in each repository that changed"
      className="btn-primary h-8 px-3.5 disabled:opacity-50"
    >
      Raise pull request
    </button>
  ) : (
    <button
      onClick={() => void c.raisePr()}
      disabled={c.busy}
      title="Open a pull request now, before every story has been accepted"
      className="h-8 px-3 text-[13px] text-muted hover:text-body disabled:opacity-50"
    >
      Raise PR early
    </button>
  );
}

/** The launch-readiness feature: same chip shape, verdict instead of a count. */
function ReadinessChip({
  c,
  selected,
  onClick,
}: {
  c: ProjectController;
  selected: boolean;
  onClick: () => void;
}) {
  const v = c.readinessVerdict;
  const dot = c.readinessRunning
    ? 'dot-pulse bg-go'
    : v?.kind === 'not-ready'
      ? 'bg-danger'
      : v?.kind === 'your-call'
        ? 'bg-warn-border'
        : 'bg-go';
  const count = v?.blockers
    ? `${v.blockers} blocker${v.blockers === 1 ? '' : 's'}`
    : v && v.risks > 0
      ? `${v.risks} risk${v.risks === 1 ? '' : 's'}`
      : v
        ? 'clear'
        : '';
  return (
    <button
      onClick={onClick}
      title={c.readinessRunning ? 'Checking what is left before launch…' : (v?.title ?? '')}
      className={`flex h-7 max-w-[280px] items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${
        selected
          ? 'border-ink bg-ink text-white'
          : 'border-line bg-surface text-body hover:border-muted'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${selected && !c.readinessRunning ? 'bg-white' : dot}`}
      />
      <span className="truncate">Launch</span>
      {count && (
        <span className={`shrink-0 text-[10px] ${selected ? 'text-white/70' : 'text-faint'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

/** One feature on the feature board: what it is, and how far along. */
function FeatureCard({ feature, onOpen }: { feature: FeaturePlan; onOpen: () => void }) {
  const plan = feature.plan;
  const stories = plan?.stories ?? [];
  const done = stories.filter((s) => s.lane === 'done').length;
  const busy = feature.generating || feature.runningStory !== null;
  return (
    <button
      onClick={onOpen}
      className="w-full rounded-lg border border-line bg-surface p-3 text-left hover:border-muted"
    >
      <div className="flex items-center gap-2">
        {busy && <span className="dot-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-go" />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {plan?.spec.feature || feature.slug || 'Feature'}
        </span>
      </div>
      {plan?.spec.overview.problem && (
        <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-body">
          {plan.spec.overview.problem}
        </p>
      )}
      <p className="mt-1.5 font-mono text-[10px] text-faint">
        {feature.generating
          ? 'writing the spec…'
          : stories.length === 0
            ? 'no stories yet'
            : `${done}/${stories.length} stories accepted`}
      </p>
      {(plan?.prUrls?.length ?? 0) > 0 && (
        <p className="mt-1.5 font-mono text-[10px] text-go">
          {plan!.prUrls!.length} pull request{plan!.prUrls!.length === 1 ? '' : 's'} open
        </p>
      )}
    </button>
  );
}

/**
 * A Feature1 feature that is assigned to you but has no board here yet.
 * Dashed, to read as an offer rather than a place: clicking it starts the
 * pull that turns it into a real feature chip.
 */
function AssignedFeaturePill({
  feature,
  pulling,
  onClick,
}: {
  feature: Feature1Feature;
  pulling: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pulling}
      title={
        pulling
          ? 'Another run is using the workspace — wait for it to finish'
          : `${feature.title}${feature.description ? ` — ${feature.description}` : ''}\n\nPull its PRD, stories and acceptance criteria into this project.`
      }
      className="flex h-7 max-w-[300px] items-center gap-1.5 rounded-full border border-dashed border-line bg-surface px-3 text-xs text-body transition-colors hover:border-muted disabled:opacity-50"
    >
      <span className="shrink-0 font-mono text-[10px] text-faint">{feature.code}</span>
      <span className="truncate">{feature.title}</span>
      {feature.storyCount !== undefined && feature.storyCount > 0 && (
        <span className="shrink-0 font-mono text-[10px] text-faint">{feature.storyCount}</span>
      )}
      <span className="shrink-0 text-[10px] text-go">+ pull</span>
    </button>
  );
}

function FeatureChip({
  feature,
  selected,
  onClick,
}: {
  feature: FeaturePlan;
  selected: boolean;
  onClick: () => void;
}) {
  const label = feature.plan?.spec.feature || feature.slug || 'Feature';
  const activeRun = feature.generating || feature.runningStory !== null;
  const doneCount = feature.plan?.stories.filter((s) => s.lane === 'done').length ?? 0;
  const total = feature.plan?.stories.length ?? 0;
  return (
    <button
      onClick={onClick}
      title={feature.generating ? 'Writing the spec…' : label}
      className={`flex h-7 max-w-[280px] items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${
        selected
          ? 'border-ink bg-ink text-white'
          : 'border-line bg-surface text-body hover:border-muted'
      }`}
    >
      {activeRun && (
        <span
          className={`dot-pulse h-1.5 w-1.5 shrink-0 rounded-full ${selected ? 'bg-white' : 'bg-go'}`}
        />
      )}
      <span className="truncate">{label}</span>
      {total > 0 && (
        <span
          className={`shrink-0 font-mono text-[10px] ${selected ? 'text-white/70' : 'text-faint'}`}
        >
          {doneCount}/{total}
        </span>
      )}
    </button>
  );
}

function StoryCard({
  story,
  c,
  testable,
  running,
  bounce,
  setBounce,
  onDragStart,
  onOpenTab,
}: {
  story: PlanStory;
  c: ProjectController;
  /** The app is running this feature's code, so a test would be honest. */
  testable: boolean;
  running: boolean;
  bounce: { code: string; feedback: string } | null;
  setBounce: (b: { code: string; feedback: string } | null) => void;
  onDragStart: () => void;
  onOpenTab: (tab: 'app' | 'logs') => void;
}) {
  const [acsOpen, setAcsOpen] = useState(false);
  const bouncing = bounce?.code === story.code;
  const implementBlocked = c.anyStoryRunning || c.planBlocked;
  return (
    <div
      draggable={!running}
      onDragStart={onDragStart}
      className={`cursor-grab rounded-lg border bg-surface p-3 active:cursor-grabbing ${
        running ? 'border-go' : 'border-line'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] text-muted">{story.code}</span>
        <span className="ml-auto rounded-full bg-paper px-1.5 py-px font-mono text-[10px] text-muted">
          {story.estimate.size} · {story.estimate.points}
        </span>
      </div>
      <p className="mt-1 text-[13px] font-medium leading-snug">{story.title}</p>
      <p className="mt-0.5 text-[11.5px] leading-snug text-body">{story.outcome}</p>
      {/* The acceptance criteria are the contract the agent implements against
          — for a Feature1 story they are its ACs verbatim — so they are here to
          read, not just to count. */}
      {story.acceptanceCriteria.length > 0 && (
        <div className="mt-1.5">
          <button
            onClick={() => setAcsOpen((v) => !v)}
            className="font-mono text-[10px] text-faint hover:text-muted"
          >
            {acsOpen ? '▾' : '▸'} {story.acceptanceCriteria.length} acceptance criteria
          </button>
          {acsOpen && (
            <ul className="mt-1 grid gap-1 border-l border-line pl-2">
              {story.acceptanceCriteria.map((ac, i) => (
                <li key={i} className="text-[11px] leading-snug text-body">
                  {ac}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {story.feedback && story.lane !== 'done' && (
        <p className="mt-1.5 rounded-md bg-warn-bg px-2 py-1 text-[10.5px] text-warn-text">
          Feedback: {story.feedback}
        </p>
      )}
      {story.prUrl && (
        <button
          onClick={() => c.openExternal(story.prUrl!)}
          className="mt-1.5 block max-w-full truncate text-left font-mono text-[10.5px] text-go hover:underline"
        >
          {story.prUrl.replace('https://', '')}
        </button>
      )}

      {running && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-go">
          <span className="dot-pulse h-1.5 w-1.5 rounded-full bg-go" /> implementing…{' '}
          <button onClick={() => onOpenTab('logs')} className="underline">
            logs
          </button>
        </p>
      )}
      {!running && (story.lane === 'todo' || (story.lane === 'coding' && !implementBlocked)) && (
        <button
          onClick={() => void c.implementStory(story.code)}
          disabled={implementBlocked}
          className="btn-primary mt-2 h-6 w-full text-[11px] disabled:opacity-50"
        >
          {story.lane === 'coding' ? 'Re-run implementation' : 'Implement'}
        </button>
      )}
      {!running && story.lane === 'testing' && !bouncing && (
        <>
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={() => onOpenTab('app')}
              disabled={!testable}
              title={
                testable
                  ? 'Open the running app'
                  : 'The app is not running this feature yet — use Test this feature above'
              }
              className="btn-secondary h-6 flex-1 text-[11px] disabled:opacity-40"
            >
              Test in App
            </button>
            <button
              onClick={() => void c.moveStory(story.code, 'done')}
              className="h-6 flex-1 rounded-md bg-go text-[11px] font-medium text-white hover:bg-go-hover"
            >
              ✓ Done
            </button>
          </div>
          {/* The app watches the source, so most of a story shows up on its
              own — but a new dependency, env var or migration needs the stack
              rebuilt, and approving unseen work is the failure that matters. */}
          <button
            onClick={() => void c.docker('restart')}
            title="Rebuild and restart the environment, for changes a running app cannot pick up on its own"
            className="mt-1.5 w-full text-left text-[10.5px] text-muted hover:text-body"
          >
            Not seeing the change? Restart the app
          </button>
        </>
      )}
      {bouncing && (
        <div className="mt-2">
          <textarea
            autoFocus
            value={bounce!.feedback}
            onChange={(e) => setBounce({ code: story.code, feedback: e.target.value })}
            placeholder="What's wrong? The agent gets this verbatim."
            rows={2}
            className="w-full rounded-md border border-warn-border bg-warn-bg p-2 text-[11.5px] outline-none placeholder:text-warn-text/60"
          />
          <div className="mt-1 flex gap-1.5">
            <button
              onClick={() => setBounce(null)}
              className="btn-secondary h-6 flex-1 text-[11px]"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                void c.moveStory(story.code, 'coding', bounce!.feedback);
                setBounce(null);
              }}
              disabled={!bounce!.feedback.trim()}
              className="btn-primary h-6 flex-1 text-[11px] disabled:opacity-50"
            >
              Send back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemList({
  label,
  items,
  uncovered,
  muted,
}: {
  label: string;
  items: SpecItem[];
  uncovered?: SpecItem[];
  muted?: boolean;
}) {
  if (items.length === 0) return null;
  const uncoveredIds = new Set((uncovered ?? []).map((i) => i.id));
  return (
    <div className="mb-4">
      <div className="section-label mb-1.5">{label}</div>
      <ul className="grid gap-1">
        {items.map((i) => (
          <li key={i.id} className="flex items-baseline gap-2 text-[13px]">
            {!muted && (
              <span
                title={uncoveredIds.has(i.id) ? 'No story covers this yet' : 'Covered by a story'}
                className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                  uncoveredIds.has(i.id) ? 'bg-warn-text' : 'bg-go'
                }`}
              />
            )}
            <span className={muted ? 'text-muted' : 'text-body'}>{i.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Center({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      {children}
    </div>
  );
}
