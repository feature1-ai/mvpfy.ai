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
 * What the screen says while it waits. A countdown nobody asked for would be
 * noise; what matters is that this is deliberate and unattended.
 */
export function waitingLine(at: Date | null): string {
  if (!at) return 'Waiting for your agent’s allowance to come back.';
  const when = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Waiting for your agent’s allowance — carrying on by itself at about ${when}.`;
}
