/**
 * Spotting a Feature1 sign-in that never happened.
 *
 * The MCP server answers an unauthenticated tool call with a normal, successful
 * result whose text begins "⚠️ Not authenticated" — not an error, not a failed
 * exit code. So the agent reads it, says something about it in passing, and the
 * run finishes green with the real problem sitting in the middle of the log.
 * The board then shows a feature that pulled nothing, and nothing anywhere says
 * the reason was a sign-in.
 *
 * This reads the run's own output for that, so the app can say it plainly and
 * offer the one thing that fixes it.
 */

const PATTERNS = [
  // The server's own wording for a tool call with no token behind it.
  /not authenticated/i,
  // What it tells the agent to do about it, in case the sentence is reflowed.
  /use "?browser_login"?/i,
  /open this url to sign in to feature1/i,
  // The authenticated-but-unidentified case, which reads as a 401 instead.
  /401[^\n]*feature1|feature1[^\n]*\b401\b/i,
];

export function needsFeature1SignIn(log: string | null | undefined): boolean {
  const text = log ?? '';
  if (!text.trim()) return false;
  return PATTERNS.some((p) => p.test(text));
}
