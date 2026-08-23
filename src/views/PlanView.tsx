import { useState } from 'react';
import type { ReactNode } from 'react';
import { ProjectController } from '../hooks/useProjectController';
import {
  LANES,
  LANE_LABELS,
  PlanStory,
  SpecItem,
  StoryLane,
  canMove,
  uncoveredItems,
} from '../lib/plan';

interface Props {
  c: ProjectController;
  onOpenTab: (tab: 'app' | 'logs') => void;
}

/** Plan tab: minimal product spec + the story board (Todo → Coding → Testing → Done). */
export default function PlanView({ c, onOpenTab }: Props) {
  const [draft, setDraft] = useState('');
  const [refine, setRefine] = useState('');
  const [dragCode, setDragCode] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<StoryLane | null>(null);
  const [bounce, setBounce] = useState<{ code: string; feedback: string } | null>(null);
  const [specOpen, setSpecOpen] = useState(false);

  const plan = c.plan;

  if (c.planGenerating) {
    return (
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
    );
  }

  if (!plan) {
    return (
      <div className="mx-auto w-full max-w-[640px] px-6 pb-20 pt-20">
        <h1 className="mb-2 text-[26px] font-semibold tracking-[-0.02em]">Plan a feature</h1>
        <p className="mb-7 text-sm leading-relaxed text-body [text-wrap:pretty]">
          Describe what you want to build. mvpfy studies the product, writes a minimal spec —
          problem, scope, flows, requirements — and breaks it into user stories you can run one by
          one on the board.
        </p>
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
            onClick={() => void c.generateSpec(draft)}
            disabled={c.busy || !draft.trim()}
            className="btn-primary h-[38px] px-4 text-sm disabled:opacity-50"
          >
            Generate spec &amp; stories
          </button>
          <span className="text-xs text-muted">~2–3 minutes, on your agent subscription</span>
        </div>
        {c.actionError && <p className="mt-3 text-[13px] text-danger">{c.actionError}</p>}
      </div>
    );
  }

  const uncovered = uncoveredItems(plan);
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
        <button onClick={() => setSpecOpen((v) => !v)} className="btn-secondary h-8 px-3.5">
          {specOpen ? 'Hide spec' : 'View spec'}
        </button>
      </div>

      {c.actionError && (
        <div className="mb-5 rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
          {c.actionError}
        </div>
      )}

      {/* Spec */}
      {specOpen && (
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
              disabled={c.busy || !refine.trim()}
              className="btn-primary h-8 px-3 text-xs disabled:opacity-50"
            >
              Refine
            </button>
          </div>
        </section>
      )}

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
        mvpfy moves stories through Coding into Testing and opens the PR. Only you can move a story
        to Done — test it in the App tab first. Drag a Testing story back to Coding to send it back
        with feedback.
      </p>
    </div>
  );
}

function StoryCard({
  story,
  c,
  bounce,
  setBounce,
  onDragStart,
  onOpenTab,
}: {
  story: PlanStory;
  c: ProjectController;
  bounce: { code: string; feedback: string } | null;
  setBounce: (b: { code: string; feedback: string } | null) => void;
  onDragStart: () => void;
  onOpenTab: (tab: 'app' | 'logs') => void;
}) {
  const running = c.planRunningStory === story.code;
  const bouncing = bounce?.code === story.code;
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
      <p className="mt-1.5 font-mono text-[10px] text-faint">
        {story.acceptanceCriteria.length} acceptance criteria
      </p>
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
      {!running && (story.lane === 'todo' || (story.lane === 'coding' && !c.busy)) && (
        <button
          onClick={() => void c.implementStory(story.code)}
          disabled={c.busy}
          className="btn-primary mt-2 h-6 w-full text-[11px] disabled:opacity-50"
        >
          {story.lane === 'coding' ? 'Re-run implementation' : 'Implement'}
        </button>
      )}
      {!running && story.lane === 'testing' && !bouncing && (
        <div className="mt-2 flex gap-1.5">
          <button onClick={() => onOpenTab('app')} className="btn-secondary h-6 flex-1 text-[11px]">
            Test in App
          </button>
          <button
            onClick={() => void c.moveStory(story.code, 'done')}
            className="h-6 flex-1 rounded-md bg-go text-[11px] font-medium text-white hover:bg-go-hover"
          >
            ✓ Done
          </button>
        </div>
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
