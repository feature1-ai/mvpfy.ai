import { describe, expect, it } from 'vitest';
import {
  MAX_FEATURES_AT_ONCE,
  cannotStartReason,
  featuresRunning,
  storyRunningFor,
} from './featureRuns';

const run = (planSlug: string, running = true) => ({ running, handle: { planSlug } });

describe('featuresRunning', () => {
  it('names each feature once, however many of its runs are going', () => {
    expect(featuresRunning([run('paging'), run('paging'), run('invoices')])).toEqual([
      'paging',
      'invoices',
    ]);
  });

  it('ignores runs that have finished', () => {
    expect(featuresRunning([run('paging', false), run('invoices')])).toEqual(['invoices']);
  });

  it('counts the legacy single plan, which has no slug', () => {
    expect(featuresRunning([{ running: true, handle: {} }])).toEqual(['']);
  });
});

describe('storyRunningFor', () => {
  it('is about one feature, not about the project', () => {
    const runs = [run('paging')];
    expect(storyRunningFor('paging', runs)).toBe(true);
    // The whole point: another feature is free to start. Its checkout, branch,
    // conversation and plan file are all its own.
    expect(storyRunningFor('invoices', runs)).toBe(false);
  });
});

describe('cannotStartReason', () => {
  it('lets a second feature start while the first is running', () => {
    expect(cannotStartReason('invoices', [run('paging')])).toBeNull();
  });

  it('refuses a feature that is already running, and says the next story is automatic', () => {
    expect(cannotStartReason('paging', [run('paging')])).toMatch(/already has a story/i);
  });

  it('holds the line at the limit, and names what is holding it', () => {
    const runs = Array.from({ length: MAX_FEATURES_AT_ONCE }, (_, i) => run(`f${i}`));
    const why = cannotStartReason('another', runs);
    expect(why).toMatch(new RegExp(`${MAX_FEATURES_AT_ONCE} features`));
    expect(why).toContain('f0');
    // Said as a cost on their machine and their allowance, which is the real
    // reason for a limit at all — not as a rule without one.
    expect(why).toMatch(/allowance/);
  });
});
