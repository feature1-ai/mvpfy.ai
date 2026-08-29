/**
 * Launch readiness: what stands between a working prototype and a product
 * real people can use. mvpfy is unusually well placed to answer this — it
 * built the local environment, so it knows which parts of the app are its own
 * stand-ins, which secrets are throwaway defaults, and where the data lives.
 *
 * The same rule as every other board applies: the agent reports findings, but
 * the VERDICT is computed here, and only the builder can decide to live with a
 * blocker. An accepted blocker stays visible as an accepted blocker — it never
 * turns green, because the risk did not go away.
 */

export type Severity = 'blocker' | 'risk' | 'note';

export const SEVERITY_LABELS: Record<Severity, string> = {
  blocker: 'blocker',
  risk: 'risk',
  note: 'worth knowing',
};

/** Ordered worst-first: the sort order of the report. */
export const SEVERITIES: Severity[] = ['blocker', 'risk', 'note'];

/** Buckets a product builder recognises, not engineering categories. */
export type Area = 'fake' | 'data' | 'secrets' | 'access' | 'money' | 'missing' | 'operations';

export const AREA_LABELS: Record<Area, string> = {
  fake: 'Still pretend',
  data: 'Your data',
  secrets: 'Keys & settings',
  access: 'Who can get in',
  money: 'Money',
  missing: 'Switched off',
  operations: 'Running it',
};

const AREAS = Object.keys(AREA_LABELS) as Area[];

export interface ReadinessFinding {
  id: string;
  /** Plain language: what is true today. */
  title: string;
  /** What happens on launch day if this ships as-is. */
  detail: string;
  /** One line: what has to change. */
  fix: string;
  severity: Severity;
  area: Area;
  /** Files (and lines) the agent read to conclude this. */
  evidence: string[];
  /** The builder decided to launch with this anyway — set by mvpfy, never
   *  by the agent, and it never clears the finding. */
  accepted: boolean;
}

export interface ReadinessReport {
  version: 1;
  generatedAt: string;
  /** One line: what this product does, as the agent understood it. */
  summary: string;
  findings: ReadinessFinding[];
}

export type Verdict = 'not-ready' | 'your-call' | 'ready';

export interface ReadinessVerdict {
  kind: Verdict;
  title: string;
  detail: string;
  blockers: number;
  /** Findings the builder chose to launch with anyway. */
  accepted: number;
  /** Of those, the ones that were blockers — the serious decisions. */
  acceptedBlockers: number;
  risks: number;
}

/**
 * Compute the verdict from the findings — never from anything the agent says
 * about its own report. Accepted blockers do not count toward readiness, but
 * they are reported separately so the decision stays visible.
 */
export function verdictFor(findings: ReadinessFinding[]): ReadinessVerdict {
  const open = findings.filter((f) => !f.accepted);
  const blockers = open.filter((f) => f.severity === 'blocker').length;
  const risks = open.filter((f) => f.severity === 'risk').length;
  const acceptedAll = findings.filter((f) => f.accepted);
  const accepted = acceptedAll.length;
  const acceptedBlockers = acceptedAll.filter((f) => f.severity === 'blocker').length;
  const counts = { blockers, accepted, acceptedBlockers, risks };
  if (blockers > 0) {
    return {
      ...counts,
      kind: 'not-ready',
      title: `Not ready to launch — ${blockers} thing${blockers === 1 ? '' : 's'} to fix first`,
      detail:
        'Each of these means real people lose money, lose data, or get into something they should not.',
    };
  }
  if (risks > 0 || accepted > 0) {
    return {
      ...counts,
      kind: 'your-call',
      title: acceptedBlockers
        ? 'Your call — you have accepted the dangerous ones'
        : 'Nothing dangerous left — the rest is your call',
      detail: acceptedBlockers
        ? `You chose to launch with ${acceptedBlockers} blocker${acceptedBlockers === 1 ? '' : 's'}. That risk is still there; it is just yours now.`
        : 'These will bite you later rather than on day one. Launch and fix, or fix first.',
    };
  }
  return {
    ...counts,
    kind: 'ready',
    title: 'Ready to launch',
    detail: 'mvpfy found nothing standing between this and real users.',
  };
}

function normalizeStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
}

/**
 * Parse an agent-written readiness report. Tolerant about shape, strict about
 * one thing: a finding may not arrive pre-accepted — accepting is the
 * builder's act, recorded in mvpfy's own state.
 */
export function parseReadiness(content: string | null | undefined): ReadinessReport | null {
  if (!content) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw.findings) ? raw.findings : [];
  const findings: ReadinessFinding[] = list
    .map((f, i): ReadinessFinding | null => {
      if (!f || typeof f !== 'object') return null;
      const o = f as Record<string, unknown>;
      const title = String(o.title ?? '').trim();
      if (!title) return null;
      const severity = SEVERITIES.includes(o.severity as Severity)
        ? (o.severity as Severity)
        : 'risk';
      const area = AREAS.includes(o.area as Area) ? (o.area as Area) : 'operations';
      return {
        id: String(o.id ?? '').trim() || `finding-${i + 1}`,
        title,
        detail: String(o.detail ?? '').trim(),
        fix: String(o.fix ?? '').trim(),
        severity,
        area,
        evidence: normalizeStrings(o.evidence),
        accepted: false,
      };
    })
    .filter((x): x is ReadinessFinding => x !== null)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  if (findings.length === 0 && !raw.summary) return null;
  return {
    version: 1,
    generatedAt: String(raw.generatedAt ?? ''),
    summary: String(raw.summary ?? '').trim(),
    findings,
  };
}

/** Apply the builder's accepted-anyway decisions to a freshly parsed report. */
export function applyAccepted(
  report: ReadinessReport | null,
  acceptedIds: string[]
): ReadinessFinding[] {
  if (!report) return [];
  const accepted = new Set(acceptedIds);
  return report.findings.map((f) => ({ ...f, accepted: accepted.has(f.id) }));
}

/** Findings grouped by area, worst area first, for the report view. */
export function groupByArea(findings: ReadinessFinding[]): Array<{
  area: Area;
  findings: ReadinessFinding[];
}> {
  const groups = new Map<Area, ReadinessFinding[]>();
  for (const f of findings) {
    const list = groups.get(f.area);
    if (list) list.push(f);
    else groups.set(f.area, [f]);
  }
  const worst = (list: ReadinessFinding[]) =>
    Math.min(...list.map((f) => SEVERITIES.indexOf(f.severity)));
  return [...groups.entries()]
    .map(([area, list]) => ({ area, findings: list }))
    .sort((a, b) => worst(a.findings) - worst(b.findings));
}
