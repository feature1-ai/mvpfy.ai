/**
 * What putting this product online would actually involve: which pieces get
 * created, what they cost, and which secrets have to become real.
 *
 * Same division of labour as everywhere else in mvpfy. The agent reads the
 * app and proposes; mvpfy computes the number that matters, decides whether
 * launching is allowed at all, and puts the decision in front of a person.
 * An agent may not total its own bill, and it may not clear its own blockers.
 */

import { ReadinessVerdict } from './readiness';

export type Provider = 'lightsail' | 'fly' | 'render' | 'railway';

export const PROVIDERS: Provider[] = ['lightsail', 'fly', 'render', 'railway'];

export const PROVIDER_LABELS: Record<Provider, string> = {
  lightsail: 'AWS Lightsail',
  fly: 'Fly.io',
  render: 'Render',
  railway: 'Railway',
};

/**
 * What the agent needs to know about each host to size it sensibly. This is
 * deliberately about the SHAPE of a provider's pricing and its right default
 * product — never the prices themselves, which go stale the moment they are
 * written down. The agent looks the current numbers up.
 */
export const PROVIDER_NOTES: Record<Provider, string> = {
  lightsail: [
    'Lightsail is priced in fixed monthly bundles rather than metered usage, which is its',
    'main advantage for someone launching their first product: the bill is knowable in',
    'advance. Name the bundle you are choosing (for example "Micro container service",',
    '"1 GB managed database") so the builder can find that exact line on the pricing page.',
    '',
    '• Use a Lightsail CONTAINER SERVICE for the app, not a bare instance: it takes the',
    '  Docker image this repo already builds, and includes HTTPS and a hostname, so the',
    '  builder does not have to administer a server or set up certificates.',
    '• Use a Lightsail MANAGED DATABASE rather than running the database in a container.',
    '  It takes automatic daily backups, which actually closes a readiness finding instead',
    '  of moving it somewhere else.',
    '• High-availability database plans cost double. Do not choose one at this stage unless',
    '  the product genuinely cannot be down for a few minutes — say so in notes if you skip it.',
    '• Each bundle includes a data-transfer allowance and bills overage beyond it. Mention',
    '  the allowance in notes so a launch cannot quietly become expensive.',
    '• Do NOT propose ECS, Fargate, RDS, an Application Load Balancer, or a hand-built VPC.',
    '  They are a different product with a bill that cannot be predicted in advance, which is',
    '  the opposite of what this builder needs.',
    '• In notes, tell them to create an IAM user limited to Lightsail rather than using their',
    '  root account or an admin key, and to check they are in the AWS account they expect.',
  ].join('\n'),
  fly: 'Fly bills per machine and per volume, with a scale-to-zero option for low-traffic apps. Name the machine size and volume size you are choosing.',
  render:
    'Render bills a flat monthly rate per service and per managed database. Name the instance type for each.',
  railway:
    'Railway bills for usage rather than fixed plans, so a resting estimate can understate a busy month. Say so in notes, and name the plan the estimate assumes.',
};

export interface LaunchResource {
  id: string;
  /** Plain language: "Your app", "Your database". */
  name: string;
  /** What it is, in the provider's terms: "web service", "Postgres". */
  kind: string;
  /** Why this product needs it. */
  detail: string;
  /** The provider's plan/size name, so the estimate can be checked. */
  size: string;
  /** Estimated cost per month, in USD. */
  monthlyUsd: number;
}

export interface LaunchSecret {
  key: string;
  /** What it is for, in plain language. */
  why: string;
  /** True when only the builder can supply it (a real key, not a generated one). */
  fromYou: boolean;
}

export interface LaunchPlan {
  version: 1;
  provider: Provider;
  region: string;
  appName: string;
  /** One line: what going live means for this product. */
  summary: string;
  resources: LaunchResource[];
  secrets: LaunchSecret[];
  /** What mvpfy would do, in order, in plain language. */
  steps: string[];
  /** Anything the builder should know before agreeing. */
  notes: string[];
}

/** The monthly estimate, totalled by mvpfy — never read from the agent. */
export function monthlyTotal(plan: LaunchPlan | null): number {
  if (!plan) return 0;
  return plan.resources.reduce(
    (sum, r) => sum + (Number.isFinite(r.monthlyUsd) ? r.monthlyUsd : 0),
    0
  );
}

/** Secrets the builder has to go and get before this can work. */
export function secretsFromYou(plan: LaunchPlan | null): LaunchSecret[] {
  return (plan?.secrets ?? []).filter((s) => s.fromYou);
}

export interface LaunchGate {
  /** True when mvpfy is willing to put this in front of real users. */
  allowed: boolean;
  /** Why not, in plain language — empty when allowed. */
  reasons: string[];
}

/**
 * Launching with open blockers is the exact thing this product exists to
 * prevent, so readiness gates it. An accepted blocker does not block: the
 * builder took that risk deliberately and it stays on their record.
 */
export function launchGate(verdict: ReadinessVerdict | null): LaunchGate {
  if (!verdict) {
    return {
      allowed: false,
      reasons: [
        'Run the launch readiness check first — mvpfy will not launch a product it has not looked at.',
      ],
    };
  }
  if (verdict.blockers > 0) {
    return {
      allowed: false,
      reasons: [
        `${verdict.blockers} blocker${verdict.blockers === 1 ? '' : 's'} still open. ` +
          'Each one means real people lose money, lose data, or get in where they should not. ' +
          'Fix them, or accept them deliberately.',
      ],
    };
  }
  return { allowed: true, reasons: [] };
}

function normalizeStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
}

function num(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Parse an agent-written launch plan. Returns null when there is nothing usable. */
export function parseLaunchPlan(content: string | null | undefined): LaunchPlan | null {
  if (!content) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const resources: LaunchResource[] = (Array.isArray(raw.resources) ? raw.resources : [])
    .map((r, i): LaunchResource | null => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      const name = String(o.name ?? '').trim();
      if (!name) return null;
      return {
        id: String(o.id ?? '').trim() || `resource-${i + 1}`,
        name,
        kind: String(o.kind ?? '').trim(),
        detail: String(o.detail ?? '').trim(),
        size: String(o.size ?? '').trim(),
        monthlyUsd: num(o.monthlyUsd),
      };
    })
    .filter((x): x is LaunchResource => x !== null);

  const secrets: LaunchSecret[] = (Array.isArray(raw.secrets) ? raw.secrets : [])
    .map((s): LaunchSecret | null => {
      if (!s || typeof s !== 'object') return null;
      const o = s as Record<string, unknown>;
      const key = String(o.key ?? '').trim();
      if (!key) return null;
      return { key, why: String(o.why ?? '').trim(), fromYou: o.fromYou === true };
    })
    .filter((x): x is LaunchSecret => x !== null);

  const provider = PROVIDERS.includes(raw.provider as Provider)
    ? (raw.provider as Provider)
    : 'fly';
  if (resources.length === 0) return null;
  return {
    version: 1,
    provider,
    region: String(raw.region ?? '').trim(),
    appName: String(raw.appName ?? '').trim(),
    summary: String(raw.summary ?? '').trim(),
    resources,
    secrets,
    steps: normalizeStrings(raw.steps),
    notes: normalizeStrings(raw.notes),
  };
}
