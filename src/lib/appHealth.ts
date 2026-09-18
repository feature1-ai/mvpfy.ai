import { ServiceState } from '../../shared/types';

/**
 * Is the app broken, still starting, or fine?
 *
 * The question used to be answered with a stopwatch: ninety seconds of silence
 * and the app was declared unresponsive. That is a guess about somebody else's
 * hardware. The same stack on a slower laptop, or with a cold image cache, or
 * behind a first-run npm install, is not broken — it is slow, and calling it
 * broken sends an agent to diagnose an app that was about to come up.
 *
 * So nothing here counts seconds. It asks docker two things it actually knows:
 * what the containers are doing, and whether anything is still being written.
 * A container that exited is not coming back, whatever the machine. A stack
 * that is still logging is getting somewhere, however slowly. Only a stack
 * that is up, silent on its port, and has stopped saying anything at all has
 * really stopped.
 */
export type AppVerdict = 'healthy' | 'starting' | 'stuck';

export interface HealthSample {
  /** The app answered on its port. */
  reachable: boolean;
  services: ServiceState[];
  /**
   * Consecutive polls in which the logs produced nothing new. Reset by the
   * caller the moment the signature changes.
   */
  quietPolls: number;
}

/**
 * How long a silent-but-running stack is given before it counts as stuck.
 * Eight polls at two seconds — sixteen seconds in which a working app wrote
 * nothing at all, which is a different claim from "sixteen seconds to boot".
 */
export const QUIET_POLLS_BEFORE_STUCK = 8;

const DEAD = new Set(['exited', 'dead', 'removing']);

export function appVerdict({ reachable, services, quietPolls }: HealthSample): AppVerdict {
  if (reachable) return 'healthy';

  // A container that died says so itself. There is nothing to wait for, on any
  // machine, so this does not wait — which is also the case the old stopwatch
  // was slowest to notice.
  if (services.some((s) => DEAD.has(s.state))) return 'stuck';
  // Crash-looping: up, down, up again. Restarting forever is not progress.
  if (services.some((s) => s.state === 'restarting')) return 'stuck';
  // The app's own healthcheck, where it has one, outranks everything here.
  if (services.some((s) => s.health === 'unhealthy')) return 'stuck';
  if (services.some((s) => s.health === 'starting')) return 'starting';

  // Nothing is up at all, and nothing is being written: there is nothing to be
  // patient with.
  if (services.length === 0) return quietPolls >= QUIET_POLLS_BEFORE_STUCK ? 'stuck' : 'starting';

  return quietPolls >= QUIET_POLLS_BEFORE_STUCK ? 'stuck' : 'starting';
}
