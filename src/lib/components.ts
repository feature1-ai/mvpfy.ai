/**
 * What this product is made of, agreed before it is built.
 *
 * Setting a product up begins by reading the repositories and inferring what
 * they add up to — a web app, an API, an admin dashboard, a worker. That
 * inference is usually right and silently wrong in one particular way: the
 * code refers to a piece that is not in the workspace. A frontend whose API
 * lives in a repository nobody added; an admin dashboard that is a separate
 * product; a mobile app that was never going to run on a laptop.
 *
 * Setup then builds what it can see and the PM gets an app that half works,
 * with nothing on screen saying which half is missing. The agent cannot settle
 * this — only the person who knows the product can say whether the thing it
 * found a reference to is somewhere else, standing in, or simply not part of
 * what they want running.
 *
 * So the inventory is written down, and the pieces that need an answer get
 * one. Everything already found is not asked about: a question with an obvious
 * answer is friction, and setup is meant to start by itself.
 */

/** What a piece of a product is, in words a PM would use. */
export type ComponentKind =
  'web' | 'api' | 'admin' | 'worker' | 'mobile' | 'desktop' | 'service' | 'database';

export const COMPONENT_LABELS: Record<ComponentKind, string> = {
  web: 'Web app',
  api: 'Backend',
  admin: 'Admin dashboard',
  worker: 'Background jobs',
  mobile: 'Mobile app',
  desktop: 'Desktop app',
  service: 'Service',
  database: 'Database',
};

/**
 * Where a component stands. `found` is the ordinary case and needs nobody.
 * `missing` is the one that matters: the code talks to it and it is not here.
 */
export type ComponentState = 'found' | 'missing';

/**
 * What the PM decided about a component.
 *
 * `remote` is the one that applies to parts the workspace DOES hold: eight
 * services in the repository, three of them worth running on a laptop and five
 * already running on a shared server. Starting all eight is minutes of build
 * time and gigabytes of memory to reproduce something that already exists at an
 * address — so the address is the answer, and the three that matter run here.
 */
export type ComponentDecision = 'elsewhere' | 'stand-in' | 'skip' | 'remote';

export interface ProductComponent {
  id: string;
  /** The product's own word for it — "Customer portal", not "frontend". */
  name: string;
  kind: ComponentKind;
  state: ComponentState;
  /** Workspace-relative directory, when the code is here. */
  repo?: string;
  /** Why the agent believes this exists: the line of code that says so. */
  evidence: string;
  /** Set once the PM has answered — or changed their mind about a found one. */
  decision?: ComponentDecision;
  /** Where it already runs, when the decision is 'remote'. */
  url?: string;
}

export interface ComponentInventory {
  components: ProductComponent[];
}

const KINDS = new Set<string>([
  'web',
  'api',
  'admin',
  'worker',
  'mobile',
  'desktop',
  'service',
  'database',
]);

const DECISIONS = new Set<string>(['elsewhere', 'stand-in', 'skip', 'remote']);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Read the inventory out of whatever the agent wrote.
 *
 * Tolerant on purpose: this is a file written by a model, and a malformed
 * entry should cost that entry rather than the whole list. An entry with no
 * name says nothing and is dropped; an unknown kind becomes 'service', which
 * is true of anything that runs.
 */
export function parseComponents(raw: string | null | undefined): ProductComponent[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { components?: unknown })?.components;
  if (!Array.isArray(list)) return [];
  const out: ProductComponent[] = [];
  for (const entry of list) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const name = text(o.name);
    if (!name) continue;
    const kind = text(o.kind).toLowerCase();
    const decision = text(o.decision).toLowerCase();
    const repo = text(o.repo);
    const state: ComponentState = text(o.state).toLowerCase() === 'missing' ? 'missing' : 'found';
    out.push({
      id: text(o.id) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      kind: (KINDS.has(kind) ? kind : 'service') as ComponentKind,
      state,
      ...(repo ? { repo } : {}),
      evidence: text(o.evidence),
      ...(DECISIONS.has(decision) ? { decision: decision as ComponentDecision } : {}),
      ...(validRemoteUrl(text(o.url)) ? { url: text(o.url) } : {}),
    });
  }
  return out;
}

/** The pieces still waiting on the only person who can answer for them. */
export function unanswered(components: ProductComponent[]): ProductComponent[] {
  return components.filter((c) => c.state === 'missing' && !c.decision);
}

/**
 * Whether setting up should wait.
 *
 * Only for a piece that is missing AND undecided. Everything found carries
 * straight on, which is the common case and the one that must not grow a
 * confirmation step: setting up starts by itself, and a question nobody needed
 * to be asked is the friction that makes people stop reading questions.
 */
export function needsAnswer(components: ProductComponent[]): boolean {
  return unanswered(components).length > 0;
}

/**
 * Where something already runs.
 *
 * Checked rather than trusted: this address is written into a file an agent
 * reads and an environment is built from, so it has to be an address and
 * nothing else. Anything with whitespace or a shell's punctuation in it is not
 * a URL somebody typed by accident.
 */
export function validRemoteUrl(value: string | null | undefined): boolean {
  const url = (value ?? '').trim();
  if (!url || /[\s'"`$;|&<>\\]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * The inventory written back, with one component's answer recorded.
 *
 * A decision that is not 'remote' drops any address that was there, so a
 * service switched back to running here cannot leave a stale URL behind for
 * the next setup to wire something to.
 */
export function withDecision(
  components: ProductComponent[],
  id: string,
  decision: ComponentDecision,
  url?: string
): ProductComponent[] {
  return components.map((c) =>
    c.id === id
      ? {
          ...c,
          decision,
          ...(decision === 'remote' && validRemoteUrl(url)
            ? { url: url!.trim() }
            : { url: undefined }),
        }
      : c
  );
}

/** Running here is the default, and the only thing that needs a container. */
export function runsLocally(component: ProductComponent): boolean {
  if (component.decision === 'remote' || component.decision === 'skip') return false;
  return component.state === 'found' || component.decision === 'elsewhere';
}

/** What setup is being asked to do, in one line the PM can check. */
export function decisionLabel(decision: ComponentDecision): string {
  return decision === 'elsewhere'
    ? 'its code is in another repository'
    : decision === 'stand-in'
      ? 'stand it in, so the rest can run'
      : decision === 'remote'
        ? 'use the one already running'
        : 'leave it out of what runs here';
}
