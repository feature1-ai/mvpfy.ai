import { describe, expect, it } from 'vitest';
import {
  launchGate,
  monthlyTotal,
  parseLaunchPlan,
  secretsFromYou,
  PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_NOTES,
} from './launchPlan';
import { ReadinessVerdict } from './readiness';

const plan = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    provider: 'fly',
    region: 'lhr',
    appName: 'mealplan',
    summary: 'A meal-planning app with checkout.',
    resources: [
      { id: 'web', name: 'Your app', kind: 'web service', size: 'shared-1x 512MB', monthlyUsd: 5 },
      { id: 'db', name: 'Your database', kind: 'Postgres', size: '1GB', monthlyUsd: 12.5 },
    ],
    secrets: [
      { key: 'STRIPE_SECRET_KEY', why: 'Taking real payments', fromYou: true },
      { key: 'SECRET_KEY_BASE', why: 'Signing logins', fromYou: false },
    ],
    steps: ['Create the app', 'Attach the database'],
    ...over,
  });

const verdict = (over: Partial<ReadinessVerdict> = {}): ReadinessVerdict => ({
  kind: 'ready',
  title: 'Ready to launch',
  detail: '',
  blockers: 0,
  accepted: 0,
  acceptedBlockers: 0,
  risks: 0,
  ...over,
});

describe('parseLaunchPlan', () => {
  it('parses the plan the agent proposes', () => {
    const p = parseLaunchPlan(plan());
    expect(p).toMatchObject({ provider: 'fly', region: 'lhr', appName: 'mealplan' });
    expect(p?.resources.map((r) => r.id)).toEqual(['web', 'db']);
    expect(p?.steps).toHaveLength(2);
  });

  it('falls back to a known provider and drops unusable entries', () => {
    const p = parseLaunchPlan(
      plan({ provider: 'my-basement', resources: [{ name: 'Your app' }, { kind: 'orphan' }] })
    );
    expect(p?.provider).toBe('fly');
    expect(p?.resources).toHaveLength(1);
    expect(p?.resources[0].monthlyUsd).toBe(0);
  });

  it('returns null for junk or a plan that creates nothing', () => {
    expect(parseLaunchPlan(null)).toBeNull();
    expect(parseLaunchPlan('nope')).toBeNull();
    expect(parseLaunchPlan(plan({ resources: [] }))).toBeNull();
  });
});

describe('monthlyTotal', () => {
  it('totals the estimate itself rather than trusting the agent', () => {
    expect(monthlyTotal(parseLaunchPlan(plan()))).toBe(17.5);
    expect(monthlyTotal(null)).toBe(0);
  });

  it('ignores a nonsense cost instead of poisoning the total', () => {
    const p = parseLaunchPlan(
      plan({
        resources: [
          { id: 'a', name: 'App', monthlyUsd: 'free' },
          { id: 'b', name: 'DB', monthlyUsd: -9 },
        ],
      })
    );
    expect(monthlyTotal(p)).toBe(0);
  });
});

describe('secretsFromYou', () => {
  it('separates what the builder must go and get', () => {
    expect(secretsFromYou(parseLaunchPlan(plan())).map((s) => s.key)).toEqual([
      'STRIPE_SECRET_KEY',
    ]);
  });
});

describe('providers', () => {
  it('offers Lightsail first — a fixed monthly bill is the safest default', () => {
    expect(PROVIDERS[0]).toBe('lightsail');
    expect(PROVIDER_LABELS.lightsail).toBe('AWS Lightsail');
  });

  it('gives every provider sizing guidance without baking in prices', () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_NOTES[p].trim().length).toBeGreaterThan(40);
      // Prices go stale; the agent looks the current ones up.
      expect(PROVIDER_NOTES[p]).not.toMatch(/\$\s?\d/);
    }
  });

  it('steers Lightsail away from the unpredictable AWS services', () => {
    expect(PROVIDER_NOTES.lightsail).toMatch(/Do NOT propose ECS, Fargate, RDS/);
    expect(PROVIDER_NOTES.lightsail).toMatch(/IAM user limited to Lightsail/);
  });

  it('parses a Lightsail plan', () => {
    expect(parseLaunchPlan(plan({ provider: 'lightsail' }))?.provider).toBe('lightsail');
  });
});

describe('launchGate', () => {
  it('refuses to launch a product that was never checked', () => {
    const gate = launchGate(null);
    expect(gate.allowed).toBe(false);
    expect(gate.reasons[0]).toMatch(/readiness check first/);
  });

  it('refuses while blockers are open', () => {
    const gate = launchGate(verdict({ kind: 'not-ready', blockers: 2 }));
    expect(gate.allowed).toBe(false);
    expect(gate.reasons[0]).toMatch(/2 blockers still open/);
  });

  it('allows a deliberately accepted blocker through', () => {
    const gate = launchGate(
      verdict({ kind: 'your-call', blockers: 0, acceptedBlockers: 1, accepted: 1 })
    );
    expect(gate).toEqual({ allowed: true, reasons: [] });
  });

  it('allows a clean report', () => {
    expect(launchGate(verdict()).allowed).toBe(true);
  });
});
