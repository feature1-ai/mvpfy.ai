import { describe, expect, it } from 'vitest';
import { BACKOFF_MINUTES, countdown, nextAttemptAt, tickEvery, waitFor } from './quotaWait';

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

describe('countdown', () => {
  const now = at('2026-10-05T10:00:00Z');
  const inSeconds = (s: number) => at(new Date(now.getTime() + s * 1000).toISOString());

  it('is coarse far out and exact when it is nearly time', () => {
    expect(countdown(now, inSeconds(3 * 3600 + 25 * 60))).toBe('in 3h 25m');
    expect(countdown(now, inSeconds(25 * 60 + 30))).toBe('in 25m 30s');
    expect(countdown(now, inSeconds(45))).toBe('in 45s');
  });

  it('reads as about to happen rather than as a stuck zero', () => {
    // The resume is a timer firing, not a clock striking: 0:00 sitting there
    // for a second or two looks like something broke.
    expect(countdown(now, inSeconds(4))).toBe('any moment now');
    expect(countdown(now, inSeconds(-600))).toBe('any moment now');
  });

  it('redraws every second only once seconds are on screen', () => {
    expect(tickEvery(now, inSeconds(120))).toBe(1000);
    expect(tickEvery(now, inSeconds(4 * 3600))).toBe(60_000);
  });
});
