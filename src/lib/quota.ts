/**
 * Spotting a run that stopped because the agent's allowance ran out.
 *
 * Worth telling apart from every other failure, because nothing is wrong: the
 * code is fine, the setup is fine, and trying again in an hour works. Read as
 * an ordinary failure it looks like something to debug, and the log that says
 * otherwise is thousands of lines up.
 *
 * Matched loosely and on purpose. Both CLIs phrase this differently, both have
 * changed the wording between versions, and neither is a contract. A miss
 * costs the banner and nothing else — the run is still a failed run, and
 * continuing it is offered either way.
 */
const PATTERNS = [
  // Claude Code, which also prints the reset time after a pipe.
  /usage limit reached/i,
  /\b\d+-hour limit reached/i,
  // Codex and the APIs underneath both, which answer 429 before saying much.
  /\b429\b/,
  /rate[_ ]?limit(_exceeded)?/i,
  /quota (exceeded|exhausted)/i,
  /insufficient[_ ]quota/i,
  /out of credits?/i,
  /credit balance is too low/i,
  /you(?:'|’)?ve (?:hit|reached) your (?:usage )?limit/i,
];

export function quotaExhausted(log: string | null | undefined): boolean {
  const text = log ?? '';
  if (!text.trim()) return false;
  return PATTERNS.some((p) => p.test(text));
}

/**
 * When the allowance comes back, if the agent said so.
 *
 * Four phrasings, because the agents and the APIs under them each say it
 * differently and none of it is a contract:
 *
 *   Claude Code   `usage limit reached|1774005600` — a unix timestamp
 *   either CLI    "try again in 25 minutes"
 *   the APIs      `retry-after: 3600`, in seconds
 *   Claude Code   "resets at 3pm" — a clock time, read as the next one to come
 *
 * Anything else yields nothing rather than a guess. A wrong time is worse than
 * no time: with none, the wait backs off and retries sensibly; with a wrong
 * one too far ahead, a feature sits waiting for an hour it did not need to.
 * The clock form is the loosest of the four, and it is still safe here —
 * reading it early costs one attempt, which then backs off.
 */
export function quotaResetAt(log: string | null | undefined, now = new Date()): Date | null {
  const text = log ?? '';

  const stamp = text.match(/usage limit reached\s*\|\s*(\d{10,13})/i);
  if (stamp) {
    const n = Number(stamp[1]);
    return finite(new Date(stamp[1].length <= 10 ? n * 1000 : n));
  }

  const after = text.match(/retry[- ]after:?\s*(\d{1,6})\b/i);
  if (after) return finite(new Date(now.getTime() + Number(after[1]) * 1000));

  const relative = text.match(/try again in\s+(\d{1,4})\s*(second|minute|hour)s?/i);
  if (relative) {
    const unit = relative[2].toLowerCase();
    const ms = unit === 'hour' ? 3_600_000 : unit === 'minute' ? 60_000 : 1000;
    return finite(new Date(now.getTime() + Number(relative[1]) * ms));
  }

  // "resets at 3pm", "reset at 15:00" — the next time that clock reads so.
  const clock = text.match(/reset(?:s|ting)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const half = clock[3]?.toLowerCase();
    if (hour > 23 || minute > 59) return null;
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    const at = new Date(now);
    at.setHours(hour, minute, 0, 0);
    // Already gone today means they meant tomorrow.
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return finite(at);
  }

  return null;
}

function finite(at: Date): Date | null {
  return Number.isFinite(at.getTime()) ? at : null;
}
