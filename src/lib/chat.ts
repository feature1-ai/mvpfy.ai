import type { ProductComponent, ComponentKind } from './components';
import { parsePorts } from './ports';

/**
 * The App tab's conversations: which parts of the product can be talked to,
 * and what an agent said back.
 *
 * Kept free of React and of window.mvpfy so every rule here is a plain
 * function a test can call.
 */

/** The workspace as a whole — compose, env files, anything no single part owns. */
export const PROJECT_APP_ID = 'project';

/** Parts of a product somebody looks at, and therefore talks about in the App tab. */
const UI_KINDS: ReadonlySet<ComponentKind> = new Set(['web', 'admin', 'mobile', 'desktop']);

export interface AppTarget {
  id: string;
  name: string;
  kind: ComponentKind | 'project';
  /** What the preview shows. Null when this part has no page here — a phone app, say. */
  url: string | null;
  /** Workspace-relative directory of its code, when it is here. */
  repo?: string;
  /** Compose service that runs it, for restarting it alone. */
  service?: string;
}

/**
 * The parts of the product the App tab offers, the whole project first.
 *
 * A part's page is found by its compose service's published port in
 * mvpfy.yml. A web part with no service of its own is shown the main app —
 * but only the first, because two portals claiming the same page would each
 * show the other's changes as their own.
 */
export function appTargets(
  components: ProductComponent[],
  mvpfyYml: string | null | undefined,
  appUrl: string
): AppTarget[] {
  const ports = parsePorts(mvpfyYml);
  const out: AppTarget[] = [
    { id: PROJECT_APP_ID, name: 'Whole project', kind: 'project', url: appUrl },
  ];
  let mainClaimed = false;
  for (const c of components) {
    if (!UI_KINDS.has(c.kind)) continue;
    if (c.decision === 'skip' || c.decision === 'elsewhere') continue;
    if (c.state === 'missing' && c.decision !== 'stand-in' && c.decision !== 'remote') continue;
    let url: string | null = null;
    if (c.decision === 'remote' && c.url) {
      url = c.url;
    } else if (c.service) {
      const port = ports.find((p) => p.label === c.service)?.port;
      if (port) url = `http://localhost:${port}`;
    }
    if (url === appUrl) mainClaimed = true;
    out.push({
      id: c.id,
      name: c.name,
      kind: c.kind,
      url,
      ...(c.repo ? { repo: c.repo } : {}),
      ...(c.service ? { service: c.service } : {}),
    });
  }
  if (!mainClaimed) {
    const first = out.find(
      (t) => t.kind !== 'project' && t.url === null && (t.kind === 'web' || t.kind === 'admin')
    );
    if (first) first.url = appUrl;
  }
  return out;
}

/** A short name for a conversation, from what was first asked in it. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || 'New chat';
}

function events(log: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A partial or non-JSON line is not an event.
    }
  }
  return out;
}

/** Text an agent has addressed to the person, latest last. */
function messages(log: string): { texts: string[]; final: string | null; error: string | null } {
  const texts: string[] = [];
  let final: string | null = null;
  let error: string | null = null;
  for (const ev of events(log)) {
    // claude -p --output-format stream-json
    if (ev.type === 'assistant') {
      const content = (ev.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            texts.push(block.text.trim());
          }
        }
      }
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string' && ev.result.trim()) final = ev.result.trim();
      if (ev.is_error === true) error = final ?? 'The agent stopped with an error.';
    }
    // codex exec --json
    const item = ev.item as Record<string, unknown> | undefined;
    if (
      ev.type === 'item.completed' &&
      item &&
      (item.type === 'agent_message' || item.type === 'assistant_message') &&
      typeof item.text === 'string' &&
      item.text.trim()
    ) {
      texts.push(item.text.trim());
    }
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      const e = ev.error as { message?: unknown } | undefined;
      const message = typeof e?.message === 'string' ? e.message : ev.message;
      error = typeof message === 'string' ? message : 'The agent stopped with an error.';
    }
  }
  return { texts, final, error };
}

/** What the agent has said so far, while it is still working. */
export function replySoFar(log: string): string | null {
  const { texts } = messages(log);
  return texts.length > 0 ? stripMarkers(texts[texts.length - 1]).text : null;
}

/** What an agent's reply says, once its closing lines are read off it. */
export interface AgentReply {
  text: string;
  /** The environment must restart to pick the change up. */
  restart: boolean;
  /** It is asking whether it may make the change it described. */
  proposal: boolean;
  error: string | null;
}

/**
 * The agent's answer once its run has ended. Claude's closing `result` is the
 * answer; codex has none, so its last message is.
 */
export function agentReply(log: string): AgentReply {
  const { texts, final, error } = messages(log);
  const answer = final ?? texts[texts.length - 1] ?? '';
  return { ...stripMarkers(answer), error };
}

/**
 * Split off the `Proposal: yes|no` and `Restart: yes|no` lines the prompts ask
 * a reply to end with, in whichever order they came and however dressed.
 */
export function stripMarkers(text: string): { text: string; restart: boolean; proposal: boolean } {
  const found: Record<string, boolean> = {};
  let rest = text;
  for (;;) {
    const match = /\n?\s*\**(Restart|Proposal):\s*(yes|no)\**\s*$/i.exec(rest);
    if (!match) break;
    found[match[1].toLowerCase()] = match[2].toLowerCase() === 'yes';
    rest = rest.slice(0, match.index);
  }
  return { text: rest.trim(), restart: found.restart ?? false, proposal: found.proposal ?? false };
}
