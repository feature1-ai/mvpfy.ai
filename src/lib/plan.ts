/**
 * Product plan model: a minimal spec (stable-ID items) plus user stories on
 * a four-lane board. The lane IS the story's status; the agent may only
 * advance Todo → Coding → Testing — moving anything into Done is the
 * human's call, always.
 */

export interface SpecItem {
  id: string;
  text: string;
}

export interface PlanSpec {
  feature: string;
  overview: {
    problem: string;
    summary: string;
    targetUsers: string;
    successMetrics: string[];
  };
  scope: { inScope: SpecItem[]; outOfScope: SpecItem[] };
  flows: SpecItem[];
  requirements: { functional: SpecItem[]; nonFunctional: SpecItem[] };
}

export type StoryLane = 'todo' | 'coding' | 'testing' | 'done';
export const LANES: StoryLane[] = ['todo', 'coding', 'testing', 'done'];
export const LANE_LABELS: Record<StoryLane, string> = {
  todo: 'To Do',
  coding: 'Coding',
  testing: 'Testing',
  done: 'Done',
};

export type TShirt = 'XS' | 'S' | 'M' | 'L' | 'XL';
const POINTS: Array<{ points: number; size: TShirt }> = [
  { points: 1, size: 'XS' },
  { points: 2, size: 'S' },
  { points: 5, size: 'M' },
  { points: 8, size: 'L' },
  { points: 13, size: 'XL' },
];

export interface PlanStory {
  code: string;
  title: string;
  outcome: string;
  acceptanceCriteria: string[];
  estimate: { size: TShirt; points: number };
  addresses: string[];
  lane: StoryLane;
  order: number;
  prUrl: string | null;
  /** Tester feedback carried into the next Coding run after a bounce. */
  feedback: string | null;
}

export interface ProjectPlan {
  version: 1;
  generatedAt: string;
  spec: PlanSpec;
  stories: PlanStory[];
}

/** Snap an arbitrary estimate to the allowed Fibonacci scale. */
export function snapEstimate(points: unknown): { size: TShirt; points: number } {
  const n = Number(points);
  if (!Number.isFinite(n)) return { points: 5, size: 'M' };
  let best = POINTS[0];
  for (const p of POINTS) {
    if (Math.abs(p.points - n) < Math.abs(best.points - n)) best = p;
  }
  return { points: best.points, size: best.size };
}

/** Deterministic short id for a spec item (FNV-1a over prefix + text). */
export function itemId(prefix: string, text: string): string {
  let h = 0x811c9dc5;
  const s = `${prefix}:${text.trim().toLowerCase()}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}-${h.toString(16).padStart(8, '0')}`;
}

/** May `actor` move a story from one lane to another? */
export function canMove(from: StoryLane, to: StoryLane, actor: 'user' | 'agent'): boolean {
  if (from === to) return false;
  if (actor === 'user') return true; // the human owns the board
  // The agent only ever advances work toward — never past — Testing.
  return (from === 'todo' && to === 'coding') || (from === 'coding' && to === 'testing');
}

/** Spec-item ids not addressed by any story. */
export function uncoveredItems(plan: ProjectPlan): SpecItem[] {
  const addressed = new Set(plan.stories.flatMap((s) => s.addresses));
  const tracked = [
    ...plan.spec.scope.inScope,
    ...plan.spec.flows,
    ...plan.spec.requirements.functional,
    ...plan.spec.requirements.nonFunctional,
  ];
  return tracked.filter((i) => !addressed.has(i.id));
}

function normalizeItems(prefix: string, raw: unknown): SpecItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      if (typeof r === 'string') return { id: itemId(prefix, r), text: r };
      if (r && typeof r === 'object') {
        const text = String((r as Record<string, unknown>).text ?? '').trim();
        if (!text) return null;
        const id = String((r as Record<string, unknown>).id ?? '') || itemId(prefix, text);
        return { id, text };
      }
      return null;
    })
    .filter((x): x is SpecItem => x !== null);
}

function normalizeStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
}

/**
 * Parse and normalize an agent-written (or hand-edited) plan file. Tolerant:
 * missing ids are computed, estimates snapped, lanes defaulted, story codes
 * minted. Returns null only when there is no usable plan at all.
 */
export function parsePlan(content: string | null | undefined): ProjectPlan | null {
  if (!content) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const specRaw = (raw.spec ?? {}) as Record<string, unknown>;
  const overviewRaw = (specRaw.overview ?? {}) as Record<string, unknown>;
  const scopeRaw = (specRaw.scope ?? {}) as Record<string, unknown>;
  const reqRaw = (specRaw.requirements ?? {}) as Record<string, unknown>;

  const spec: PlanSpec = {
    feature: String(specRaw.feature ?? raw.feature ?? '').trim(),
    overview: {
      problem: String(overviewRaw.problem ?? '').trim(),
      summary: String(overviewRaw.summary ?? '').trim(),
      targetUsers: String(overviewRaw.targetUsers ?? '').trim(),
      successMetrics: normalizeStrings(overviewRaw.successMetrics),
    },
    scope: {
      inScope: normalizeItems('in', scopeRaw.inScope),
      outOfScope: normalizeItems('out', scopeRaw.outOfScope),
    },
    flows: normalizeItems('flow', specRaw.flows),
    requirements: {
      functional: normalizeItems('fn', reqRaw.functional),
      nonFunctional: normalizeItems('nf', reqRaw.nonFunctional),
    },
  };

  const storiesRaw = Array.isArray(raw.stories) ? raw.stories : [];
  const stories: PlanStory[] = storiesRaw
    .map((s, i): PlanStory | null => {
      if (!s || typeof s !== 'object') return null;
      const o = s as Record<string, unknown>;
      const title = String(o.title ?? '').trim();
      if (!title) return null;
      const lane = LANES.includes(o.lane as StoryLane) ? (o.lane as StoryLane) : 'todo';
      const est = (o.estimate ?? {}) as Record<string, unknown>;
      return {
        code: String(o.code ?? '') || `US-${String(i + 1).padStart(2, '0')}`,
        title,
        outcome: String(o.outcome ?? o.description ?? '').trim(),
        acceptanceCriteria: normalizeStrings(o.acceptanceCriteria),
        estimate: snapEstimate(est.points ?? o.points),
        addresses: normalizeStrings(o.addresses),
        lane,
        order: Number.isFinite(Number(o.order)) ? Number(o.order) : i,
        prUrl: typeof o.prUrl === 'string' && o.prUrl ? o.prUrl : null,
        feedback: typeof o.feedback === 'string' && o.feedback.trim() ? o.feedback.trim() : null,
      };
    })
    .filter((x): x is PlanStory => x !== null)
    .sort((a, b) => a.order - b.order);

  if (!spec.feature && stories.length === 0) return null;
  return { version: 1, generatedAt: String(raw.generatedAt ?? ''), spec, stories };
}

export function serializePlan(plan: ProjectPlan): string {
  return JSON.stringify(plan, null, 2) + '\n';
}
