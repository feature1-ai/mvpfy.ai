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

// What an agent said back, read off its output: shared with the hosted runner.
export { agentReply, replySoFar, stripMarkers, titleFrom } from '../../shared/chat';
export type { AgentReply } from '../../shared/chat';
