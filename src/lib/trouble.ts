import { ServiceState } from '../../shared/types';

/**
 * What is wrong with the environment right now, in a form an agent can act on.
 *
 * Shared by Diagnose & fix and by the Agent tab: asking "why will my app not
 * start?" should begin from the same evidence the diagnose button has, not
 * from nothing. The run log only exists in memory, so an agent sent to look
 * for it would find nothing at all.
 *
 * Empty when nothing is wrong — the caller then says nothing rather than
 * describing a problem that does not exist.
 */
export function troubleReport(input: {
  /** Tail of the run that failed, when one did. */
  failedLog: string | null;
  /** The app started but never answered: a failure with no failed run. */
  unresponsive: boolean;
  stoppedServices: ServiceState[];
}): string {
  const { failedLog, unresponsive, stoppedServices } = input;
  if (!failedLog && !unresponsive && stoppedServices.length === 0) return '';

  const parts: string[] = [];
  if (stoppedServices.length > 0) {
    parts.push(
      'These services are not running:\n' +
        stoppedServices
          .map((s) => `${s.service}: ${s.state}${s.exitCode ? ` (exit ${s.exitCode})` : ''}`)
          .join('\n') +
        '\nTheir container logs say why.'
    );
  } else if (unresponsive) {
    parts.push(
      'Every container is running, but nothing answers on the app port. The app is likely ' +
        'failing during startup, or listening on a different port than the compose file ' +
        'publishes.'
    );
  }
  if (failedLog) {
    parts.push(`Tail of the last environment run:\n---\n${failedLog}\n---`);
  }
  return `THE ENVIRONMENT IS NOT WORKING RIGHT NOW.\n\n${parts.join('\n\n')}`;
}
