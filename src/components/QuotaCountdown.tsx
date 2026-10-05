import { useEffect, useState } from 'react';
import { countdown, tickEvery } from '../lib/quotaWait';

/**
 * The wait, ticking.
 *
 * A time the agent gave — "carrying on at about 1:05 pm" — is a fact the
 * builder has to do arithmetic on to use. A countdown is the same fact without
 * the arithmetic, and the difference matters here because the question being
 * asked is "do I wait for this or go and do something else".
 *
 * It redraws every second only once seconds are on screen; a countdown of
 * hours ticking every second is a render loop nobody asked for.
 */
export default function QuotaCountdown({ at }: { at: Date }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), tickEvery(new Date(), at));
    return () => clearInterval(timer);
    // Re-armed when the target moves, which is also when the interval it
    // should use may have changed.
  }, [at]);

  return (
    <span
      // The time itself in the tooltip: a countdown answers "how long", and a
      // clock time answers "shall I come back after lunch".
      title={`Carrying on at about ${at.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })}`}
      className="font-mono text-[12px] tabular-nums text-warn-text"
    >
      {countdown(now, at)}
    </span>
  );
}
