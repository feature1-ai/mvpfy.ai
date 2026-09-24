import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { FeaturePlan, ProjectController } from '../hooks/useProjectController';
import { needsFeature1SignIn } from '../lib/feature1Auth';
import type { PullRequestState } from '../../shared/types';
import {
  LANES,
  LANE_LABELS,
  PlanStory,
  ProjectPlan,
  SpecItem,
  StoryLane,
  featureLane,
  uncoveredItems,
} from '../lib/plan';
import { Feature1Feature } from '../lib/feature1Mcp';
import { explainRaiseFailure } from '../lib/raiseFailure';
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
  const [bounce, setBounce] = useState<{ code: string; feedback: string } | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
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
  // Both the features already pulled and the ones being pulled right now. The
  // plan file carries the reference only once the run has finished writing it,
  // which is minutes after the pull began — and an offer that stays up for
  // those minutes is an offer somebody takes twice.
  const pulledRefs = new Set(
    [
      ...plans.map((f) => f.plan?.feature1FeatureRef ?? ''),
      ...Object.values(c.project.feature1Refs ?? {}),
    ]
      .map((r) => r.toLowerCase())
      .filter(Boolean)
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
        onClick={c.refresh}
        title="Re-read plans, stories, launch readiness and pull request status"
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
          <Feature1Push c={c} plan={plan} />
          <ImplementFeatureButton c={c} plan={plan} slug={active.slug} />
          <TestFeatureButton c={c} slug={active.slug} />
          <FeatureShipControls c={c} plan={plan} />
          <button onClick={() => setSpecOpen((v) => !v)} className="btn-secondary h-8 px-3.5">
            {specOpen ? 'Hide spec' : 'View spec'}
          </button>
          <button
            onClick={() => setDeleteArmed((v) => !v)}
            className={`h-8 shrink-0 px-2.5 text-[13px] ${
              deleteArmed ? 'text-danger' : 'text-muted hover:text-danger'
            }`}
          >
            Delete
          </button>
        </div>
      </div>

      {c.actionError && (
        <div className="mb-5 rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
          {c.actionError}
        </div>
      )}

      {/* git and gh say why in several lines, not one. A truncated line here
          is the difference between a report and a screenshot of a dead end. */}
      {/* A row of its own. Inlined in the header it had no room: the text ran
          off the edge, the buttons went with it, and the feature's own title
          collapsed to one word a line. */}
      {deleteArmed && (
        <ConfirmDeleteFeature
          c={c}
          plan={plan}
          onCancel={() => setDeleteArmed(false)}
          onConfirm={() => {
            setDeleteArmed(false);
            void c.deleteFeature();
          }}
        />
      )}

      {/* Whatever a stopped run left behind, and the one way to pick it up. */}
      <ContinueFeature c={c} />

      {/* Read from git, not from any run's account of what it did. */}
      <UnfinishedMerge c={c} />

      <FailedRaise c={c} plan={plan} />

      {/* A run that reached Feature1 and was turned away says so only in its
          own log, and exits zero doing it. */}
      <Feature1NotSignedIn c={c} />

      {/* The other half of the same question: whether the pull request happened
          is the point of the button, so success is stated as plainly as failure. */}
      <RaisedPullRequests c={c} plan={plan} />

      {/* Whose turn it is, when every story is accepted but the feature is not. */}
      <AwaitingAcceptance c={c} plan={plan} />

      {/* What it should look like, next to what it should do. A feature
          carried a PRD and nothing about its interface, so implementation
          invented one — the part a PM can see is wrong without being able to
          say why. */}
      <FeatureDesign c={c} plan={plan} slug={active.slug} />

      {/* Spec (the agreed PRD, collapsible) */}
      {specOpen && specCard}

      {/* Board */}
      <div className="grid grid-cols-2 items-start gap-4 min-[980px]:grid-cols-4">
        {LANES.map((lane) => (
          // A lane is a report of where the work is, not a control. The feature
          // is implemented as a whole, so a story cannot be dragged into Coding
          // ahead of the ones before it, and dropping one into Done would mark
          // work accepted that no run ever did.
          <div
            key={lane}
            className="min-h-[220px] rounded-[10px] border border-line bg-sunken p-2.5"
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
        mvpfy moves stories through Coding into Testing as it implements the feature. Only you can
        move a story to Done — test it in the App tab first, and send it back with feedback if it is
        not right. Every story in this feature commits to one branch, and one pull request opens for
        the whole feature once you have accepted them all.
      </p>

      {/* Asking for a change in words, when the change is not a story. The
          board above says what was planned; this is everything else — the
          wording, the spacing, the thing that only shows up once you use it. */}
      {plan.approved && <FeatureChangeBox c={c} />}
    </div>
  );
}

/**
 * A change to this feature's code, asked for in plain language and committed
 * to its branch.
 *
 * Separate from Ask mvpfy, which fixes the environment in the workspace and
 * commits nothing. This one is the product's code, so it belongs to the
 * feature: its checkouts, its branch, its conversation, its pull request.
 */
function FeatureChangeBox({ c }: { c: ProjectController }) {
  const [text, setText] = useState('');
  const busy = c.changingFeature;
  return (
    <div className="mt-4 rounded-[10px] border border-line bg-sunken p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="section-label">Change this feature</span>
        <span className="text-[11px] text-faint">
          committed to its branch — it goes out with the feature
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim() && !busy) {
              const t = text;
              setText('');
              void c.changeFeature(t);
            }
          }}
          disabled={busy}
          placeholder="e.g. the date on the invoice list should read 14 Mar 2026, not 2026-03-14"
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted disabled:opacity-60"
        />
        <button
          onClick={() => {
            const t = text;
            setText('');
            void c.changeFeature(t);
          }}
          disabled={busy || !text.trim()}
          className="btn-primary h-8 shrink-0 px-3 text-xs disabled:opacity-50"
        >
          {busy ? 'Changing…' : 'Make the change'}
        </button>
      </div>
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
  // A feature being implemented has a branch that is still moving, so there is
  // nothing settled to check out yet. Implementing also ends any test in
  // progress, which is what keeps the checkout from quietly falling behind.
  const implementing = c.anyStoryRunning;
  // Behind its own branch: only reachable now if the repository was moved by
  // hand, but saying "Running this feature" when it is not remains the lie
  // that gets a story accepted on work nobody saw.
  const stale = live && c.testingStale && !implementing;
  return (
    <button
      onClick={() => void c.testFeature(live && !stale ? null : slug)}
      disabled={c.busy || implementing}
      title={
        implementing
          ? 'A story is being implemented — its code is still changing. Test it once that finishes.'
          : stale
            ? 'The workspace has moved off this feature — put it back on the latest commit'
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
      {implementing
        ? 'Test when this finishes'
        : stale
          ? 'Not on this feature — check out'
          : live
            ? '● Running this feature'
            : 'Test this feature'}
    </button>
  );
}

/** Why raising the pull request failed, in git's own words. */
function FailedRaise({ c, plan }: { c: ProjectController; plan: ProjectPlan }) {
  const raise =
    c.runHistory
      .filter((r) => r.handle.kind === 'raise-pr' && r.handle.planSlug === c.activePlan?.slug)
      .pop() ?? (plan.lastRaise ? { ...plan.lastRaise, running: false } : undefined);
  if (!raise || raise.running || raise.exitCode === 0) {
    return null;
  }
  // The command is echoed as the log's first line and is half the answer —
  // which repository, which branch, which base — so it is kept alongside the
  // tail rather than scrolled off by it.
  const lines = raise.log.trim().split('\n').filter(Boolean);
  const output = (lines.length > 13 ? [lines[0], '…', ...lines.slice(-12)] : lines).join('\n');
  const explained = explainRaiseFailure(raise.log);
  return (
    <section className="card mb-5 overflow-hidden border-danger/30">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <span className="section-label text-danger">
          {plan.prUrls?.length
            ? 'Some pull requests could not be raised'
            : 'The pull request was not raised'}
        </span>
      </div>
      {/* The plain-language reading first: git explains itself to engineers,
          and the same failure said plainly is the difference between a dead
          end and a next step. Its own words stay below, for when they help. */}
      {explained && (
        <div className="border-b border-line-subtle px-5 py-4">
          <p className="text-[13.5px] font-medium">{explained.title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-body">{explained.fix}</p>
          {explained.repairable && (
            <button
              onClick={() => void c.repairGitAuth().then((ok) => ok && c.raisePr())}
              disabled={c.busy}
              className="btn-primary mt-3 h-[34px] px-3.5 text-[13px] disabled:opacity-50"
            >
              Connect git to GitHub and try again
            </button>
          )}
        </div>
      )}
      <div className="px-5 py-3">
        <button onClick={() => void c.raisePr()} disabled={c.busy} className="btn-secondary mb-3">
          Retry raising pull requests
        </button>
        <p className="mb-1.5 text-[11.5px] text-muted">
          {explained ? 'What git and gh said' : 'git and gh said this'}
        </p>
        <pre className="max-h-[200px] overflow-auto font-mono text-[11.5px] leading-relaxed text-body">
          {output || '(the run produced no output)'}
        </pre>
      </div>
    </section>
  );
}

/**
 * Filing a locally-planned feature in Feature1, and the link once it is there.
 * A feature that was pulled from Feature1 already has a record there, so this
 * offers nothing — pushing it again would split its history in two.
 */
function Feature1Push({ c, plan }: { c: ProjectController; plan: ProjectPlan }) {
  if (!c.tenantConnected) return null;
  // Filed once is not filed for ever: the spec gets refined and the stories
  // move, and Feature1 keeps whatever it was told first unless something says
  // otherwise. The link is the label; bringing it up to date is the button.
  if (plan.feature1FeatureRef) {
    return (
      <span className="flex items-center gap-2">
        <span
          title="This feature is in Feature1 — its stories and acceptance criteria are linked"
          className="font-mono text-[11.5px] text-muted"
        >
          Feature1 · {plan.feature1FeatureRef}
        </span>
        <button
          onClick={() => void c.syncFeature()}
          disabled={c.busy || c.syncingFeature}
          title="Send the current spec, the stories added since, and where every story has got to"
          className="btn-secondary h-8 px-3.5 disabled:opacity-50"
        >
          {c.syncingFeature ? 'Syncing…' : 'Sync'}
        </button>
      </span>
    );
  }
  if (plan.stories.length === 0) return null;
  return (
    <button
      onClick={() => void c.pushFeature()}
      disabled={c.busy || c.pushingFeature}
      title="Create this feature in Feature1 with its PRD, user stories and acceptance criteria"
      className="btn-secondary h-8 px-3.5 disabled:opacity-50"
    >
      {c.pushingFeature ? 'Pushing to Feature1…' : 'Push to Feature1'}
    </button>
  );
}

/**
 * A run that quietly did nothing because Feature1 was never signed in.
 *
 * The MCP server answers an unauthenticated call with an ordinary successful
 * result — "⚠️ Not authenticated. Use browser_login…" — so the run ends green
 * and the only trace is a line in the middle of a log nobody opens. What the
 * person sees is a feature that pulled nothing, for no stated reason.
 */
function Feature1NotSignedIn({ c }: { c: ProjectController }) {
  // The most recent finished run, not the most recent one that had the
  // problem. Looking for any run that ever hit it meant the warning stayed up
  // for good: signing in and running something successfully could not clear a
  // run that had already happened, so the app went on saying it was not
  // signed in while the top of the window said it was.
  const run = c.runHistory.filter((r) => !r.running).pop();
  if (!run || !needsFeature1SignIn(run.log)) return null;
  return (
    <section className="card mb-5 overflow-hidden border-warn-border">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="section-label text-warn-text">Feature1 was not signed in</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="max-w-[440px] text-[13px] text-body">
          That run reached Feature1 but was not signed in, so it read nothing and finished anyway.
          Sign in and run it again — nothing was changed in Feature1, and nothing here was lost.
        </p>
        <button
          onClick={() => void c.feature1Login.connect()}
          disabled={c.feature1Login.status === 'waiting'}
          className="btn-secondary h-8 shrink-0 px-3.5 disabled:opacity-50"
        >
          {c.feature1Login.status === 'waiting'
            ? 'Waiting for the browser…'
            : 'Sign in to Feature1'}
        </button>
      </div>
    </section>
  );
}

/** State, checks and review, in the three words each is worth. */
function PrBadges({ pr }: { pr: PullRequestState }) {
  if (pr.error) {
    return (
      <span title={pr.error} className="text-[11px] text-muted">
        could not be read
      </span>
    );
  }
  const chip = (text: string, tone: 'go' | 'warn' | 'danger' | 'muted') => (
    <span
      key={text}
      className={`rounded-full px-1.5 py-[1px] text-[10.5px] ${
        tone === 'go'
          ? 'bg-go-bg text-go'
          : tone === 'warn'
            ? 'bg-warn-bg text-warn-text'
            : tone === 'danger'
              ? 'bg-red-50 text-danger'
              : 'bg-sunken text-muted'
      }`}
    >
      {text}
    </span>
  );
  const out = [];
  if (pr.state === 'MERGED') out.push(chip('merged', 'go'));
  else if (pr.state === 'CLOSED') out.push(chip('closed without merging', 'danger'));
  else if (pr.isDraft) out.push(chip('draft', 'muted'));
  else out.push(chip('open', 'muted'));

  // Checks stop mattering once it is in — whatever they said, it shipped.
  if (pr.state !== 'MERGED' && pr.state !== 'CLOSED') {
    if (pr.checks === 'failing') out.push(chip('checks failing', 'danger'));
    else if (pr.checks === 'pending') out.push(chip('checks running', 'warn'));
    else if (pr.checks === 'passing') out.push(chip('checks passed', 'go'));
    if (pr.reviewDecision === 'APPROVED') out.push(chip('approved', 'go'));
    else if (pr.reviewDecision === 'CHANGES_REQUESTED')
      out.push(chip('changes requested', 'danger'));
    else if (pr.reviewDecision === 'REVIEW_REQUIRED') out.push(chip('needs review', 'warn'));
  }
  return <>{out}</>;
}

/**
 * Confirming the removal of a feature's board.
 *
 * What it removes and what it leaves is the whole question, so this says both
 * rather than asking "are you sure?" — a question nobody can answer without
 * already knowing the answer. The commits and pull requests are counted,
 * because deleting a feature with eleven commits behind it should read
 * differently from deleting an empty one, and only the app knows which it is.
 */
function ConfirmDeleteFeature({
  c,
  plan,
  onCancel,
  onConfirm,
}: {
  c: ProjectController;
  plan: ProjectPlan;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const built = c.featureGit.reduce((n, r) => n + r.ahead, 0);
  const prs = plan.prUrls?.length ?? 0;
  const keeps =
    built > 0 || prs > 0
      ? `The branch keeps its ${built > 0 ? `${built} commit${built === 1 ? '' : 's'}` : 'work'}${
          prs > 0 ? `, and ${prs} pull request${prs === 1 ? '' : 's'} stay open` : ''
        }.`
      : 'Nothing in git is touched.';
  return (
    <section className="card mb-5 overflow-hidden border-danger/30">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="section-label text-danger">Delete this feature?</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="max-w-[520px] text-[13px] text-body">
          Removes the plan, the spec, the designs and this feature&apos;s checkouts.{' '}
          <strong className="font-medium text-ink">{keeps}</strong>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onConfirm}
            disabled={c.busy}
            className="h-8 rounded-md bg-danger px-3.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            Delete it
          </button>
          <button onClick={onCancel} className="h-8 px-2.5 text-[13px] text-muted hover:text-body">
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * The design this feature is built to match.
 *
 * Images are copied into the workspace so the agent can open them the way it
 * opens anything else, and shown back here so the product manager can see what
 * the agent was given rather than trusting that it was given anything.
 */
function FeatureDesign({
  c,
  plan,
  slug,
}: {
  c: ProjectController;
  plan: ProjectPlan;
  slug: string;
}) {
  const design = plan.design ?? { images: [], links: [] };
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [editingLinks, setEditingLinks] = useState(false);
  const [linkText, setLinkText] = useState(design.links.join('\n'));
  const key = design.images.join('|');

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void Promise.all(
      key.split('|').map(async (name) => {
        const url = await c.readDesign(slug, name).catch(() => null);
        return [name, url] as const;
      })
    ).then((pairs) => {
      if (cancelled) return;
      setThumbs(Object.fromEntries(pairs.filter(([, url]) => url) as Array<[string, string]>));
    });
    return () => {
      cancelled = true;
    };
  }, [key, slug, c]);

  const empty = design.images.length === 0 && design.links.length === 0;
  return (
    <section className="card mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <span className="section-label">Design</span>
        <span className="text-[11.5px] text-muted">
          {empty
            ? 'What it should look like. Without one, the agent invents an interface.'
            : 'What the agent is told to match.'}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setEditingLinks((v) => !v)}
            className="text-[11.5px] text-go hover:underline"
          >
            {design.links.length > 0 ? 'Edit links' : 'Add a link'}
          </button>
          <button
            onClick={() => void c.addDesign()}
            disabled={c.busy}
            className="btn-secondary h-7 px-3 text-[11.5px] disabled:opacity-50"
          >
            Add images
          </button>
        </div>
      </div>

      {design.images.length > 0 && (
        <div className="flex flex-wrap gap-2.5 px-5 py-3">
          {design.images.map((name) => (
            <figure key={name} className="group relative">
              {thumbs[name] ? (
                <img
                  src={thumbs[name]}
                  alt={name}
                  className="h-[92px] w-auto max-w-[190px] rounded-md border border-line object-cover"
                />
              ) : (
                <div className="flex h-[92px] w-[130px] items-center justify-center rounded-md border border-line bg-sunken px-2 text-center font-mono text-[10px] text-faint">
                  {name}
                </div>
              )}
              <button
                onClick={() => void c.removeDesign(name)}
                title={`Remove ${name}`}
                className="absolute right-1 top-1 hidden rounded bg-ink/80 px-1.5 text-[11px] text-white group-hover:block"
              >
                ×
              </button>
            </figure>
          ))}
        </div>
      )}

      {editingLinks && (
        <div className="flex flex-col gap-2 border-t border-line-subtle px-5 py-3">
          <textarea
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            placeholder="https://www.figma.com/file/…&#10;one per line"
            rows={2}
            spellCheck={false}
            className="w-full rounded-md border border-line bg-surface p-2 font-mono text-[11.5px] outline-none placeholder:text-faint focus:border-muted"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void c.setDesignLinks(linkText.split('\n'));
                setEditingLinks(false);
              }}
              className="btn-primary h-7 px-3 text-[11.5px]"
            >
              Save
            </button>
            <span className="text-[11px] text-muted">
              The agent cannot open a Figma link — it is here so a person can.
            </span>
          </div>
        </div>
      )}

      {design.links.length > 0 && !editingLinks && (
        <div className="flex flex-col items-start gap-1 border-t border-line-subtle px-5 py-2.5">
          {design.links.map((l) => (
            <button
              key={l}
              onClick={() => c.openExternal(l)}
              className="max-w-full truncate font-mono text-[11.5px] text-go hover:underline"
            >
              {l.replace(/^https?:\/\//, '')}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A feature that was left part-way, and the one button that picks it up.
 *
 * Three things can strand a feature — a story stopped halfway, a change that
 * never committed, or both — and from outside they are one situation: work was
 * being done, it stopped, and it is still in the checkout. Telling them apart
 * is not the builder's job, so it is not their button either.
 */
function ContinueFeature({ c }: { c: ProjectController }) {
  const s = c.stranded;
  if (!s) return null;
  const what = s.story
    ? `${s.story} stopped part-way`
    : `work here was never committed${s.files > 1 ? ` — ${s.files} files` : ''}`;
  return (
    <section
      className={`card mb-5 overflow-hidden ${s.quota ? 'border-warn-border' : 'border-line'}`}
    >
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className={`section-label ${s.quota ? 'text-warn-text' : 'text-muted'}`}>
          {s.quota ? `The agent's allowance ran out — ${what}` : `This feature stopped — ${what}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="max-w-[460px] text-[13px] text-body">
          {s.quota
            ? 'Nothing is wrong with the code or the setup — the run used up what your subscription allows. '
            : ''}
          Everything it had done is still in this feature&apos;s checkout. Continuing reads what is
          already there and carries on from it — it does not start again, and it does not undo
          anything — then works through the rest of the feature.
        </p>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            onClick={() => void c.continueFeature()}
            disabled={c.busy}
            className="btn-primary h-8 px-3.5 disabled:opacity-50"
          >
            Continue feature
          </button>
          {/* Continuing needs the agent, which is the one thing you do not have
              when the allowance is what ran out. Banking the work needs
              nothing, so it stays reachable — quietly, as the lesser answer. */}
          {s.files > 0 && (
            <button
              onClick={() => void c.commitFeatureWork()}
              disabled={c.busy}
              title="Commit what is on disk without finishing it — for when the agent is unavailable and you do not want the work loose"
              className="text-[11.5px] text-muted hover:text-body disabled:opacity-50"
            >
              or just commit what is there
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * A merge that was started in a feature's checkout and never finished.
 *
 * The quieter way a checkout stops working: every later run in it fails on the
 * merge rather than on what it was asked to do, and the error never mentions a
 * merge. Uncommitted work used to be reported here too, with its own button —
 * it belongs to Continue feature now, which is the one answer to "a run
 * stopped and left something behind".
 */
function UnfinishedMerge({ c }: { c: ProjectController }) {
  const merging = c.featureGit.filter((r) => r.mergeInProgress);
  if (merging.length === 0) return null;
  const names = merging.map((r) => r.repo.split(/[/\\]/).pop()).join(', ');
  return (
    <section className="card mb-5 overflow-hidden border-warn-border">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="section-label text-warn-text">A merge was left unfinished</span>
      </div>
      <div className="px-5 py-3">
        <p className="text-[13px] text-body">
          {names} stopped part-way through a merge. Until it is finished or abandoned, every run in
          that checkout fails on the merge rather than on what it was asked to do. Run{' '}
          <code className="font-mono text-[12px]">git merge --abort</code> there, or ask for it in
          Change this feature.
        </p>
      </div>
    </section>
  );
}

/**
 * The pull requests that were raised. A raise that worked used to leave a
 * truncated URL in the header and nothing else — the same silence as one that
 * failed, at the moment the answer matters most.
 */
function RaisedPullRequests({ c, plan }: { c: ProjectController; plan: ProjectPlan }) {
  const urls = plan.prUrls ?? [];
  if (urls.length === 0) return null;
  return (
    <section className="card mb-5 overflow-hidden border-go/30">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-go" />
        <span className="section-label text-go">
          {urls.length === 1 ? 'Pull request raised' : `${urls.length} pull requests raised`}
        </span>
      </div>
      <div className="px-5 py-3">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <p className="text-[12px] text-muted">
            What GitHub says about them now — checks and reviews arrive after mvpfy is done.
          </p>
          <button
            onClick={() => c.refreshPrStates()}
            disabled={c.prStatesLoading}
            className="shrink-0 text-[11.5px] text-go hover:underline disabled:text-muted disabled:no-underline"
          >
            {c.prStatesLoading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        <div className="flex flex-col items-start gap-1.5">
          {urls.map((url) => {
            const pr = c.prStates.find((x) => x.url === url);
            return (
              <div key={url} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  onClick={() => c.openExternal(url)}
                  className="max-w-full truncate font-mono text-[11.5px] text-go hover:underline"
                >
                  {url.replace('https://', '')}
                </button>
                {pr && <PrBadges pr={pr} />}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * Every story accepted, and the feature still in Testing. That is correct —
 * accepting the stories is not the same as accepting what they add up to —
 * but the board said nothing about whose turn it was, so it read as stuck.
 */
function AwaitingAcceptance({ c, plan }: { c: ProjectController; plan: ProjectPlan }) {
  const allDone = plan.stories.length > 0 && plan.stories.every((s) => s.lane === 'done');
  if (!allDone || plan.tested === true || (plan.prUrls?.length ?? 0) > 0) return null;
  return (
    <section className="card mb-5 overflow-hidden border-warn-border">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <span className="section-label text-warn-text">This feature is waiting for you</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="text-[13px] text-body">
          All {plan.stories.length} stories are accepted, so the feature stays in Testing until you
          accept the feature itself. Try it end to end first — accepting moves it to Done.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void c.markFeatureTested()}
            disabled={c.busy}
            className="btn-secondary h-8 px-3.5 disabled:opacity-50"
          >
            Accept feature
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Getting the finished feature out: the builder's gate over the whole set,
 * then its pull requests. Stories are still accepted one at a time — this is
 * the second gate, over what they add up to.
 */
function FeatureShipControls({ c, plan }: { c: ProjectController; plan: ProjectPlan }) {
  const prUrls = plan.prUrls ?? [];
  // The raise is a run like any other, and a run that failed said so only in
  // the Logs tab. Whether the pull request happened is the whole point of the
  // button, so its outcome belongs next to it.
  const raise =
    c.runHistory
      .filter((r) => r.handle.kind === 'raise-pr' && r.handle.planSlug === c.activePlan?.slug)
      .pop() ?? (plan.lastRaise ? { ...plan.lastRaise, running: false } : undefined);
  if (raise?.running) {
    return <span className="text-[13px] text-muted">Raising the pull request…</span>;
  }
  if (prUrls.length === 0 && raise && raise.exitCode !== 0) {
    return (
      <button
        onClick={() => void c.raisePr()}
        disabled={c.busy}
        className="h-8 rounded-md bg-danger px-3.5 text-[13px] font-medium text-white disabled:opacity-50"
      >
        Raising failed — try again
      </button>
    );
  }
  // The links live in the panel below, which has room for all of them. Here,
  // where the button was, what belongs is the answer to what the button did.
  if (prUrls.length > 0) {
    return (
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-go">
        <span className="h-1.5 w-1.5 rounded-full bg-go" />
        {prUrls.length === 1 ? 'Pull request raised' : `${prUrls.length} pull requests raised`}
      </span>
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
        // In order, not together: both report through the same error slot, and
        // two at once means whichever finishes last decides what is shown.
        void c.markFeatureTested().then(() => c.raisePr());
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
  onOpenTab,
}: {
  story: PlanStory;
  c: ProjectController;
  /** The app is running this feature's code, so a test would be honest. */
  testable: boolean;
  running: boolean;
  bounce: { code: string; feedback: string } | null;
  setBounce: (b: { code: string; feedback: string } | null) => void;
  onOpenTab: (tab: 'app' | 'logs') => void;
}) {
  const [acsOpen, setAcsOpen] = useState(false);
  const bouncing = bounce?.code === story.code;
  return (
    <div
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
          {/* Sending a story back used to mean dragging it out of Testing.
              With dragging gone it needs a control of its own — and a button
              says it is there, which the drag never did. */}
          <button
            onClick={() => setBounce({ code: story.code, feedback: '' })}
            className="mt-1.5 w-full text-left text-[10.5px] text-muted hover:text-body"
          >
            Not right? Send it back with feedback
          </button>
          {/* The app watches the source, so most of a story shows up on its
              own — but a new dependency, env var or migration needs the stack
              rebuilt, and approving unseen work is the failure that matters. */}
          {/* The Plan tab's only environment control, and deliberately kept:
              it is the one place where not seeing a change is the question
              being asked. Same action and same words as Restart in Overview. */}
          <button
            onClick={() => void c.docker('restart')}
            title="Stop and start the environment — applies env and config changes"
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
