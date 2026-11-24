import { load } from 'js-yaml';
import { manifestPorts } from '../../shared/manifest';

export interface PortEntry {
  label: string;
  port: number;
}

/**
 * The host port the main app is actually published on, according to
 * mvpfy.yml. The agent may deviate from the assigned base port (e.g. when it
 * turns out to be taken at build time), so the written file — not the stored
 * project state — is the source of truth. Looks for the first `host_port:`
 * anywhere in the document, then a `url: http://localhost:<port>`, then the
 * first `services:` entry's host port. Null when nothing usable is found.
 */
export function parseAppPort(mvpfyYml: string | null | undefined): number | null {
  if (!mvpfyYml) return null;
  const { hostPort, urlPort } = manifestPorts(mvpfyYml);
  if (hostPort !== null) return hostPort;
  if (urlPort !== null) return urlPort;
  const first = parsePorts(mvpfyYml)[0];
  return first ? first.port : null;
}

/**
 * Extract host ports from a project's mvpfy.yml `services:` list for the
 * Overview ports row. Tolerant: bad yaml or shape yields [].
 */
export function parsePorts(mvpfyYml: string | null | undefined): PortEntry[] {
  if (!mvpfyYml) return [];
  let doc: unknown;
  try {
    doc = load(mvpfyYml);
  } catch {
    return [];
  }
  const services = (doc as { services?: unknown })?.services;
  if (!Array.isArray(services)) return [];
  const out: PortEntry[] = [];
  for (const svc of services as Array<Record<string, unknown>>) {
    if (!svc || typeof svc !== 'object') continue;
    const ports = svc.ports;
    if (!Array.isArray(ports) || ports.length === 0) continue;
    const first = String(ports[0]);
    const host = Number(first.split(':')[0]);
    if (!Number.isInteger(host)) continue;
    out.push({ label: String(svc.name ?? 'service'), port: host });
  }
  return out;
}
