import { describe, expect, it } from 'vitest';
import { BACKOFF_MINUTES, nextAttemptAt, waitFor, waitingLine } from './quotaWait';

const at = (iso: string) => new Date(iso);

describe('nextAttemptAt', () => {
  it('waits for the time the agent gave, plus a minute of slack', () => {
    // Claude Code prints when the allowance comes back. Believing it beats
    // guessing — and the slack is because the two clocks are not the same one.
    const now = at('2026-10-05T10:00:00Z');
    const reset = at('2026-10-05T13:00:00Z');
    expect(nextAttemptAt(now, reset, 0)?.toISOString()).toBe('2026-10-05T13:01:00.000Z');
  });

  it('backs off when the agent said nothing', () => {
    const now = at('2026-10-05T10:00:00Z');
    expect(nextAttemptAt(now, null, 0)?.toISOString()).toBe('2026-10-05T10:15:00.000Z');
    expect(nextAttemptAt(now, null, 1)?.toISOString()).toBe('2026-10-05T10:30:00.000Z');
    expect(nextAttemptAt(now, null, 2)?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
  });

  it('ignores a reset time that has already passed', () => {
    // It said 1pm, it is 2pm, and it is still refusing: the stated time is
    // spent, so this falls back to waiting rather than retrying in a loop.
    const now = at('2026-10-05T14:00:00Z');
    const reset = at('2026-10-05T13:00:00Z');
    expect(nextAttemptAt(now, reset, 0)?.toISOString()).toBe('2026-10-05T14:15:00.000Z');
  });

  it('gives up rather than waiting forever', () => {
    // Something other than the allowance is wrong by now, and a person should
    // look. Silence from something that promised to carry on is worse than
    // being told it stopped.
    const now = at('2026-10-05T10:00:00Z');
    expect(nextAttemptAt(now, null, BACKOFF_MINUTES.length)).toBeNull();
  });
});

describe('waitFor', () => {
  it('is the time left, and never negative', () => {
    expect(waitFor(at('2026-10-05T10:00:00Z'), at('2026-10-05T10:05:00Z'))).toBe(300_000);
    expect(waitFor(at('2026-10-05T10:05:00Z'), at('2026-10-05T10:00:00Z'))).toBe(0);
  });
});

describe('waitingLine', () => {
  it('says it is deliberate, and unattended', () => {
    expect(waitingLine(at('2026-10-05T13:01:00Z'))).toMatch(/carrying on by itself/i);
    expect(waitingLine(null)).toMatch(/waiting for your agent/i);
  });
});
