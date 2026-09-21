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
 * When the allowance comes back, if the agent said so. Claude Code prints a
 * unix timestamp after a pipe; anything else yields nothing rather than a
 * guess, because a wrong time is worse than no time.
 */
export function quotaResetAt(log: string | null | undefined): Date | null {
  const m = (log ?? '').match(/usage limit reached\s*\|\s*(\d{10,13})/i);
  if (!m) return null;
  const n = Number(m[1]);
  const ms = m[1].length <= 10 ? n * 1000 : n;
  const at = new Date(ms);
  return Number.isFinite(at.getTime()) ? at : null;
}
