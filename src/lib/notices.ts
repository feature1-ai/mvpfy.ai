/**
 * What mvpfy says when the builder is not watching.
 *
 * Every run here is long and unattended by design — a feature takes the
 * afternoon, and the whole point is that nobody sits through it. So the moments
 * that end the waiting have to reach somebody who walked away: the feature is
 * ready to try, the allowance ran out, the work came back from Feature1 or went
 * to it.
 *
 * Written as plain sentences about their product rather than about mvpfy's
 * machinery, because a notification is read in two seconds on a lock screen.
 * Kept here, apart from the showing of them, so what is said can be tested
 * without an operating system.
 */

export interface Notice {
  title: string;
  body: string;
}

const named = (name: string) => name.trim() || 'Your feature';

/** Every story implemented and waiting to be tried. */
export function featureImplemented(name: string, stories: number): Notice {
  return {
    title: `${named(name)} is ready to test`,
    body:
      stories === 1
        ? 'Its story is implemented and waiting for you in Testing.'
        : `All ${stories} stories are implemented and waiting for you in Testing.`,
  };
}

/**
 * The allowance ran out. Nothing is wrong, which is the thing to say first —
 * read as an ordinary failure this is the one that sends somebody debugging
 * code that is fine.
 */
export function quotaRanOut(name: string, resetAt: Date | null): Notice {
  const when = resetAt
    ? `Your agent's allowance comes back at ${resetAt.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })}`
    : "Your agent's allowance has run out";
  return {
    title: `${named(name)} is paused`,
    body: `${when}. Nothing is wrong with the code — mvpfy carries on by itself when it is back, and everything done so far is kept.`,
  };
}

/** Back from waiting, carrying on where it stopped. */
export function quotaBack(name: string, story: string | null): Notice {
  return {
    title: `Carrying on with ${named(name)}`,
    body: story
      ? `Your allowance is back, so ${story} is being implemented again.`
      : 'Your allowance is back, so the rest of the feature is being implemented.',
  };
}

/** Waited, retried, and it is still not back. */
export function quotaStillOut(name: string): Notice {
  return {
    title: `${named(name)} is still waiting`,
    body: "Your agent's allowance has not come back yet. Open mvpfy and press Continue feature when it has.",
  };
}

/**
 * A feature's spec is written and its board is open. Pulling one from Feature1
 * and planning one here are the same run and end the same wait; where it came
 * from is the only difference worth saying.
 */
export function featurePulled(name: string, stories: number, fromFeature1 = false): Notice {
  const where = fromFeature1 ? 'Pulled from Feature1' : 'Its spec is written';
  return {
    title: `${named(name)} is on your board`,
    body:
      stories > 0
        ? `${where}, with ${stories} ${stories === 1 ? 'story' : 'stories'} to read and agree.`
        : `${where} — ready to read.`,
  };
}

export function featurePushed(name: string): Notice {
  return {
    title: `${named(name)} is in Feature1`,
    body: 'Its PRD, stories and their status are up to date there.',
  };
}
