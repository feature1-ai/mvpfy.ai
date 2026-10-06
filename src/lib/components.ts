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
  /**
   * The env file THIS part reads, workspace-relative.
   *
   * Not the same file for everything. A compose stack reads one at the
   * workspace root, and that is where ports and image settings belong — but a
   * Vite frontend inlines VITE_* from its own repository at build time, a Rails
   * app reads its own, and a phone app is configured in neither. A variable
   * written to the wrong one is set and ignored, which is the worst kind of
   * set: everything claims success and the app behaves as though it was never
   * given the value.
   */
  envFile?: string;
  /**
   * The compose service that runs it, when one does. What makes restarting
   * this part alone possible — and what tells mvpfy that a part it is showing
   * is actually a container rather than a client or an address.
   */
  service?: string;
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
      ...(safeEnvPath(text(o.envFile)) ? { envFile: text(o.envFile) } : {}),
      ...(validServiceName(text(o.service)) ? { service: text(o.service) } : {}),
    });
  }
  return out;
}

/**
 * A part the product manager says exists, that reading the code never found.
 *
 * The inventory is built from evidence, which is what stops it inventing an
 * admin dashboard because a README mentions one — and it is exactly why a
 * mobile app in its own repository can be invisible here. Nothing in a backend
 * necessarily says a phone talks to it. The person who knows the product is
 * the only source for that, so there has to be a way for them to say it.
 *
 * It arrives missing and undecided, which is to say it arrives as a question —
 * the same one, answered the same four ways.
 */
export function addComponent(
  components: ProductComponent[],
  name: string,
  kind: ComponentKind
): ProductComponent[] {
  const label = name.trim();
  if (!label) return components;
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'component';
  let id = base;
  for (let n = 2; components.some((c) => c.id === id); n++) id = `${base}-${n}`;
  return [
    ...components,
    { id, name: label, kind, state: 'missing', evidence: 'You said this is part of the product' },
  ];
}

/**
 * An env path inside the workspace and nothing else.
 *
 * It is read from a model-written file and then written to, so it may not
 * climb out of the workspace, name an absolute path, or be anything but an env
 * file. A wrong path here overwrites something that is not env.
 */
export function safeEnvPath(value: string | null | undefined): boolean {
  const path = (value ?? '').trim();
  if (!path || path.length > 200) return false;
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return false;
  if (path.split(/[\\/]/).some((part) => part === '..')) return false;
  return /(^|[\\/])\.env(\.[A-Za-z0-9_.-]+)?$/.test(path);
}

/** A compose service name and nothing else: it reaches a command line. */
export function validServiceName(value: string | null | undefined): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test((value ?? '').trim());
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

/**
 * A part of the product that runs on somebody's own machine, not in the
 * environment mvpfy builds.
 *
 * A phone app and a desktop app are clients: they are installed, launched and
 * looked at by a person, and no container on localhost is any of those things.
 * Calling them "runs here" beside a web app and a database was a lie with a
 * green dot next to it — and the lie points the wrong way, because what the
 * builder actually needs to know about a client is the address to point it at.
 */
export function isClient(kind: ComponentKind): boolean {
  return kind === 'mobile' || kind === 'desktop';
}

/** Running here is the default, and the only thing that needs a container. */
export function runsLocally(component: ProductComponent): boolean {
  // A client is never built here, whatever else is true of it.
  if (isClient(component.kind)) return false;
  if (component.decision === 'remote' || component.decision === 'skip') return false;
  return component.state === 'found' || component.decision === 'elsewhere';
}

/**
 * What this part is doing, in one line. A client gets the address it should be
 * pointed at, because that is the only thing mvpfy can usefully tell somebody
 * about an app they will launch themselves.
 */
export function componentLine(component: ProductComponent, appUrl: string): string {
  if (isClient(component.kind)) {
    return component.decision === 'skip' ? 'left out' : `you run this one — point it at ${appUrl}`;
  }
  if (component.decision) return decisionLabel(component.decision);
  return component.state === 'found' ? 'runs here' : 'not here yet';
}

/** What setup is being asked to do, in one line the PM can check. */
export function decisionLabel(decision: ComponentDecision): string {
  return decision === 'elsewhere'
    ? 'its code is in another repository'
    : decision === 'stand-in'
      ? 'faked, so the rest can run'
      : decision === 'remote'
        ? 'use the one already running'
        : 'leave it out of what runs here';
}
