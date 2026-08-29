/**
 * Bootstrap as a flow: the setup run's work as cards, so the PM sees what
 * mvpfy is about to do to their app — and what it actually did.
 *
 * Who is allowed to say "done" is the whole point of this model:
 *
 *   • the AGENT may only ever claim "doing" (or "blocked" when it needs the
 *     PM) — a self-reported "done" is a narrative, not a fact;
 *   • MVPFY marks a technical task done when it can SEE the files it declared;
 *     a claim it cannot confirm lands in "check", never silently green;
 *   • the HUMAN owns the last card — the app actually up with a working demo
 *     login — exactly like a user story: mvpfy moves it to Testing, the PM
 *     tries it and moves it to Done.
 */

export type TaskLane = 'todo' | 'doing' | 'check' | 'testing' | 'done' | 'blocked';

export const TASK_LANE_LABELS: Record<TaskLane, string> = {
  todo: 'to do',
  doing: 'working',
  check: 'unconfirmed',
  testing: 'ready to test',
  done: 'done',
  blocked: 'needs you',
};

export type TaskActor = 'agent' | 'system' | 'human';

export interface BootstrapTask {
  id: string;
  /** Plain language, product-facing — what this means for the PM's app. */
  title: string;
  detail: string;
  lane: TaskLane;
  /** Workspace-relative files this task produces: mvpfy's proof it happened. */
  files: string[];
  order: number;
}

export interface BootstrapFlow {
  version: 1;
  generatedAt: string;
  /** One line: what this product is, in the agent's own words. */
  summary: string;
  tasks: BootstrapTask[];
}

/** A task plus what mvpfy could actually verify about it. */
export interface ResolvedTask extends BootstrapTask {
  /** True only when mvpfy saw the task's files on disk — not a claim. */
  verified: boolean;
}

/** The final card, owned by mvpfy and gated on the human. */
export const RUNNING_TASK_ID = 'app-running';

/** May `actor` move a task between these lanes? */
export function canMoveTask(
  from: TaskLane,
  to: TaskLane,
  actor: TaskActor,
  isFinal = false
): boolean {
  if (from === to) return false;
  if (isFinal) {
    // Shipping the setup is the PM's call: mvpfy can only offer it up.
    if (to === 'done') return actor === 'human';
    return actor !== 'agent';
  }
  if (to === 'done') return actor === 'system'; // evidence, never a claim
  if (to === 'testing') return false; // only the final card is testable
  if (to === 'blocked') return actor !== 'human';
  return actor !== 'agent' || to === 'doing';
}

const LANES: TaskLane[] = ['todo', 'doing', 'check', 'testing', 'done', 'blocked'];

/**
 * Declared paths may or may not carry the linked-mode `.mvpfy/` prefix — the
 * agent is told to write there, and it sometimes spells it out. Compare bare.
 */
export function bareFilePath(p: string): string {
  return p
    .trim()
    .replace(/^\.\//, '')
    .replace(/^\.mvpfy\//, '');
}

function normalizeStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
}

/** Parse an agent-written flow file. Returns null when there is nothing usable. */
export function parseBootstrapFlow(content: string | null | undefined): BootstrapFlow | null {
  if (!content) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: BootstrapTask[] = tasksRaw
    .map((t, i): BootstrapTask | null => {
      if (!t || typeof t !== 'object') return null;
      const o = t as Record<string, unknown>;
      const title = String(o.title ?? '').trim();
      if (!title) return null;
      const id = String(o.id ?? '').trim() || `task-${i + 1}`;
      // The final card is mvpfy's, not the agent's — drop any imitation.
      if (id === RUNNING_TASK_ID) return null;
      return {
        id,
        title,
        detail: String(o.detail ?? o.description ?? '').trim(),
        lane: LANES.includes(o.lane as TaskLane) ? (o.lane as TaskLane) : 'todo',
        files: normalizeStrings(o.files),
        order: Number.isFinite(Number(o.order)) ? Number(o.order) : i,
      };
    })
    .filter((x): x is BootstrapTask => x !== null)
    .sort((a, b) => a.order - b.order);
  if (tasks.length === 0) return null;
  return {
    version: 1,
    generatedAt: String(raw.generatedAt ?? ''),
    summary: String(raw.summary ?? '').trim(),
    tasks,
  };
}

export function serializeBootstrapFlow(flow: BootstrapFlow): string {
  return JSON.stringify(flow, null, 2) + '\n';
}

export interface FlowEvidence {
  /** Workspace-relative paths that exist right now (bare, no .mvpfy/). */
  presentFiles: string[];
  /** A setup run is in flight — an unfinished claim is still plausible. */
  running: boolean;
  /** The stack is up and the app answers on its port. */
  appHealthy: boolean;
  /** The PM confirmed they can see the app with the demo login. */
  accepted: boolean;
}

/**
 * Turn the agent's claims plus what mvpfy can observe into the board the PM
 * sees, and append the final human-gated card. This is the only place a task
 * is allowed to become "done".
 */
export function resolveFlow(flow: BootstrapFlow | null, ev: FlowEvidence): ResolvedTask[] {
  const present = new Set(ev.presentFiles.map(bareFilePath));
  const tasks: ResolvedTask[] = (flow?.tasks ?? []).map((task) => {
    if (task.lane === 'blocked') return { ...task, verified: false };
    const declared = task.files.map(bareFilePath);
    if (declared.length > 0) {
      const complete = declared.every((f) => present.has(f));
      if (complete) return { ...task, lane: 'done', verified: true };
      // Files promised but not there: the claim does not stand on its own.
      const lane: TaskLane = ev.running ? (task.lane === 'done' ? 'doing' : task.lane) : 'check';
      return { ...task, lane, verified: false };
    }
    // Nothing to check against (reading the code, warming Docker): the claim
    // stands, but it is never marked verified — and a claim left mid-flight
    // after the run ended is surfaced rather than left spinning.
    const lane: TaskLane = !ev.running && task.lane === 'doing' ? 'check' : task.lane;
    return { ...task, lane, verified: false };
  });

  return [
    ...tasks,
    {
      id: RUNNING_TASK_ID,
      title: 'See your app running',
      detail: 'Open it with the demo login and check you can actually use it.',
      lane: ev.accepted ? 'done' : ev.appHealthy ? 'testing' : ev.running ? 'doing' : 'todo',
      files: [],
      order: Number.MAX_SAFE_INTEGER,
      verified: ev.accepted,
    },
  ];
}
