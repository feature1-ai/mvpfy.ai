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
export type Area =
  | 'fake'
  | 'data'
  | 'secrets'
  | 'access'
  | 'money'
  | 'missing'
  | 'operations'
  | 'structure'
  | 'model';

export const AREA_LABELS: Record<Area, string> = {
  fake: 'Still pretend',
  data: 'Your data',
  secrets: 'Keys & settings',
  access: 'Who can get in',
  money: 'Money',
  missing: 'Switched off',
  operations: 'Running it',
  structure: 'How it is built',
  model: 'Your data model',
};

/**
 * Areas that answer "can I keep building on this?" rather than "is it safe to
 * launch?". Both are worth knowing, but they are different questions, and a
 * badly structured app does not lose anyone's money on launch day — so these
 * can never be blockers. Keeping that word for real danger is what makes it
 * mean anything.
 */
const CODE_HEALTH_AREAS: Area[] = ['structure', 'model'];

export function isCodeHealth(area: Area): boolean {
  return CODE_HEALTH_AREAS.includes(area);
}

const AREAS = Object.keys(AREA_LABELS) as Area[];

/**
 * Who can actually close this. Some findings are a change to the code in
 * front of us; others need something only a person can obtain or decide — a
 * real payment account, a managed database, a domain. Defaults to 'you',
 * because offering to fix something mvpfy cannot fix is worse than silence.
 */
export type FixableBy = 'mvpfy' | 'you';

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
  fixableBy: FixableBy;
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

/**
 * Areas that decide how the product holds up AFTER launch rather than whether
 * it survives the day: how the code is organised, whether its own concepts
 * exist, and what happens when something breaks. None of them block a launch.
 * Together they answer the question a builder actually asks once the
 * dangerous list is clear — "should I feel good about this?"
 */
const CONFIDENCE_AREAS: Area[] = ['structure', 'model', 'operations'];

export type ConfidenceLevel = 'solid' | 'workable' | 'fragile';

export interface Confidence {
  level: ConfidenceLevel;
  title: string;
  /** What it means for the next thing they build, not for the code. */
  detail: string;
  /** Open findings behind the judgement. */
  count: number;
}

/**
 * How much confidence the code itself justifies. Advisory only — this never
 * gates a launch. The moment it did, it would be a blocker by another name,
 * and the whole point is that these are not blockers.
 *
 * Counts open findings, like the verdict: an accepted one has been weighed
 * and is reported separately rather than nagged about twice.
 */
export function confidenceFor(findings: ReadinessFinding[]): Confidence {
  const open = findings.filter((f) => !f.accepted && CONFIDENCE_AREAS.includes(f.area));
  const serious = open.filter((f) => f.severity === 'risk').length;
  const count = open.length;
  if (count === 0) {
    return {
      level: 'solid',
      title: 'Solid',
      detail:
        'Nothing in how this is built will get in your way — the next feature should go in cleanly.',
      count,
    };
  }
  if (serious >= 3 || count >= 5) {
    return {
      level: 'fragile',
      title: 'Fragile',
      detail:
        'You can launch this, but changing it afterwards will be harder than it should be. Worth fixing some of these before you build much more on top.',
      count,
    };
  }
  return {
    level: 'workable',
    title: 'Workable',
    detail:
      'Nothing here stops you launching. You will feel these the next time you change the product, not before.',
    count,
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
      const claimed = SEVERITIES.includes(o.severity as Severity)
        ? (o.severity as Severity)
        : 'risk';
      const area = AREAS.includes(o.area as Area) ? (o.area as Area) : 'operations';
      // How the code is organised is never a launch blocker, whatever the
      // agent calls it. If bad structure genuinely endangers users, that is a
      // finding in 'access' or 'data', where it can block properly.
      const severity: Severity = isCodeHealth(area) && claimed === 'blocker' ? 'risk' : claimed;
      // Only an explicit claim makes something mvpfy-fixable.
      const fixableBy: FixableBy = o.fixableBy === 'mvpfy' ? 'mvpfy' : 'you';
      return {
        id: String(o.id ?? '').trim() || `finding-${i + 1}`,
        title,
        detail: String(o.detail ?? '').trim(),
        fix: String(o.fix ?? '').trim(),
        severity,
        area,
        fixableBy,
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
