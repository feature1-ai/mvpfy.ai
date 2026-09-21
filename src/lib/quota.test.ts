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

  it('says nothing rather than guessing when there is no time in the log', () => {
    // A wrong "try again at" is worse than no time at all.
    expect(quotaResetAt('rate_limit_exceeded')).toBeNull();
    expect(quotaResetAt('usage limit reached')).toBeNull();
  });
});
