import { describe, expect, it } from 'vitest';
import { quotaExhausted, quotaResetAt } from './quota';

describe('quotaExhausted', () => {
  it('spots the allowance running out, in the wordings the agents use', () => {
    expect(quotaExhausted('Claude AI usage limit reached|1774005600')).toBe(true);
    expect(quotaExhausted('5-hour limit reached')).toBe(true);
    expect(quotaExhausted('{"status":429,"error":{"type":"rate_limit_exceeded"}}')).toBe(true);
    expect(quotaExhausted('Your credit balance is too low to run this')).toBe(true);
    expect(quotaExhausted("You've hit your usage limit")).toBe(true);
  });

  it('leaves an ordinary failure alone', () => {
    // A test failure and a missing module are things to fix, not to wait out.
    expect(quotaExhausted('FAIL src/app.test.ts — expected 2 received 3')).toBe(false);
    expect(quotaExhausted("Cannot find module '@rollup/rollup-darwin-x64'")).toBe(false);
    expect(quotaExhausted('')).toBe(false);
    expect(quotaExhausted(null)).toBe(false);
  });
});

describe('quotaResetAt', () => {
  it('reads the reset time when the agent prints one', () => {
    const at = quotaResetAt('Claude AI usage limit reached|1774005600');
    expect(at?.getTime()).toBe(1774005600000);
  });

  it('reads the relative forms the agents print', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    expect(quotaResetAt('try again in 25 minutes', now)?.toISOString()).toBe(
      '2026-10-05T10:25:00.000Z'
    );
    expect(quotaResetAt('Try again in 2 hours', now)?.toISOString()).toBe(
      '2026-10-05T12:00:00.000Z'
    );
    expect(quotaResetAt('retry-after: 3600', now)?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
  });

  it('reads a clock time as the next time the clock reads it', () => {
    // Local time, because that is the clock the message is written against
    // and the one the builder is looking at.
    const morning = new Date(2026, 9, 5, 10, 0, 0);
    const at = quotaResetAt('Your limit resets at 3pm', morning);
    expect(at?.getHours()).toBe(15);
    expect(at?.getDate()).toBe(5);

    // Said in the evening, a time already gone means tomorrow.
    const evening = new Date(2026, 9, 5, 22, 0, 0);
    const tomorrow = quotaResetAt('resets at 9:30am', evening);
    expect(tomorrow?.getDate()).toBe(6);
    expect(tomorrow?.getHours()).toBe(9);
    expect(tomorrow?.getMinutes()).toBe(30);
  });

  it('says nothing rather than guessing when there is no time in the log', () => {
    // A wrong "try again at" is worse than no time at all: with none, the wait
    // backs off sensibly; with one too far ahead, a feature sits for an hour
    // it never needed to.
    expect(quotaResetAt('rate_limit_exceeded')).toBeNull();
    expect(quotaResetAt('usage limit reached')).toBeNull();
    expect(quotaResetAt('reset at 99:99')).toBeNull();
  });
});
