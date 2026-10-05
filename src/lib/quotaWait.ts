/**
 * Waiting out an allowance, and carrying on by itself when it is back.
 *
 * A feature that stops on quota is the one failure where doing nothing is the
 * right fix — the code is fine and an hour makes it work. Until now that hour
 * was the builder's to notice, remember and act on, which in practice means a
 * feature sits half-implemented until somebody opens the app and wonders why.
 *
 * When the agent says when it is back, that is used. When it does not, this
 * backs off rather than guessing: a retry too early spends nothing and learns
 * nothing, and a dozen of them look like a loop.
 */

/** How long to wait before each attempt, when the agent gave no reset time. */
export const BACKOFF_MINUTES = [15, 30, 60, 60, 60, 60];

/** A minute past the stated reset, because the two clocks are not the same one. */
const SLACK_MS = 60_000;

/**
 * When to try again — or null when it has waited long enough that something
 * else is wrong and a person should look.
 *
 * `attempt` is how many tries have already failed on quota: 0 is the first
 * wait, after the failure that started it.
 */
export function nextAttemptAt(now: Date, resetAt: Date | null, attempt: number): Date | null {
  if (attempt >= BACKOFF_MINUTES.length) return null;
  if (resetAt && resetAt.getTime() + SLACK_MS > now.getTime()) {
    return new Date(resetAt.getTime() + SLACK_MS);
  }
  return new Date(now.getTime() + BACKOFF_MINUTES[attempt] * 60_000);
}

/** Milliseconds to wait, floored so a time already past fires promptly. */
export function waitFor(now: Date, at: Date): number {
  return Math.max(0, at.getTime() - now.getTime());
}

/**
 * How long is left, as a person would say it.
 *
 * Coarse while it is far away and exact in the last minute, because that is
 * when the number is actually being watched. A wait that has run out reads as
 * about to happen rather than as 0:00 — the resume is a timer firing, not a
 * clock striking, and a frozen zero looks like something broke.
 */
export function countdown(now: Date, at: Date): string {
  const left = Math.max(0, at.getTime() - now.getTime());
  if (left < 10_000) return 'any moment now';
  const seconds = Math.ceil(left / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * How often to redraw it: every second once the seconds are shown, and once a
 * minute while they are not. A countdown of hours that repaints every second
 * is a render loop nobody asked for.
 */
export function tickEvery(now: Date, at: Date): number {
  return at.getTime() - now.getTime() < 3_600_000 ? 1000 : 60_000;
}
