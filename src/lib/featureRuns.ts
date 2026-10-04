/**
 * Which features are being implemented, and how many may be at once.
 *
 * Everything about implementing a story is already per-feature: its own
 * checkout, its own branch, its own conversation with the agent, its own plan
 * file. Two features therefore cannot write the same anything — the one reason
 * stories were serialised in the first place. What was left was a single
 * project-wide "a story is running" flag, which refused a second feature on a
 * ground that stopped being true when worktrees arrived.
 *
 * The limit that remains is real but different: every run is an agent session
 * on somebody's laptop, spending an allowance that is theirs and competing for
 * the same processor. So features run side by side up to a number, and the
 * number is said out loud rather than discovered as a stall.
 */

/** How many features may be implemented at the same time. */
export const MAX_FEATURES_AT_ONCE = 3;

/** The shape this reads — a story run, as the runs API reports it. */
export interface StoryRunLike {
  running: boolean;
  handle: { planSlug?: string };
}

/** The features with a story being implemented right now, without repeats. */
export function featuresRunning(runs: StoryRunLike[]): string[] {
  const out: string[] = [];
  for (const run of runs) {
    if (!run.running) continue;
    const slug = run.handle.planSlug ?? '';
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

/** True when this feature already has a story being implemented. */
export function storyRunningFor(slug: string, runs: StoryRunLike[]): boolean {
  return featuresRunning(runs).includes(slug);
}

/**
 * Why this feature cannot start now, in the words the builder needs — or null
 * when it can. A feature already running says so; a full house names the
 * others, because "wait" is only useful when you know what for.
 */
export function cannotStartReason(slug: string, runs: StoryRunLike[]): string | null {
  const running = featuresRunning(runs);
  if (running.includes(slug)) {
    return 'This feature already has a story being implemented — its stories run one after another, so the next one starts by itself.';
  }
  if (running.length >= MAX_FEATURES_AT_ONCE) {
    return `${MAX_FEATURES_AT_ONCE} features are already being implemented (${running
      .map((s) => s || 'the first feature')
      .join(
        ', '
      )}). Each one is an agent run on your machine, spending your allowance — this one starts when one of them finishes.`;
  }
  return null;
}
