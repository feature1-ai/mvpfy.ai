import { load } from 'js-yaml';

export interface PortEntry {
  label: string;
  port: number;
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
