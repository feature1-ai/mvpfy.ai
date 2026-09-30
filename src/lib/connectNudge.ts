import { MvpfyState, Project } from '../../shared/types';

/**
 * When to ask a product manager to connect Feature1.
 *
 * mvpfy alone is single-player: the plan lives in one folder on one machine.
 * The moment that stops being enough is right after the first feature has
 * been planned on a project that is actually set up — before that there is
 * nothing to share, and a nudge would just be noise on the setup screens.
 * Once connected the question is answered, so the nudge never returns.
 *
 * "Not now" is honoured for a while rather than forever: the person who
 * dismissed it while trying the tool out is not the person who, weeks later,
 * has three features on the board and a teammate asking where the plan is.
 */
export const CONNECT_NUDGE_KEY = 'mvpfy.connectFeature1.dismissedAt';
export const CONNECT_NUDGE_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

/** A project counts once its setup was accepted and at least one feature has a plan. */
export function projectHasPlannedFeature(project: Project): boolean {
  return project.bootstrapAccepted === true && (project.planSlugs?.length ?? 0) > 0;
}

export function shouldShowConnectNudge(
  state: Pick<MvpfyState, 'tenant' | 'projects'>,
  dismissedAt: string | null,
  now: Date = new Date()
): boolean {
  if (state.tenant?.tokenKeychainEntry) return false;
  if (!state.projects.some(projectHasPlannedFeature)) return false;
  if (!dismissedAt) return true;
  const dismissed = Date.parse(dismissedAt);
  if (Number.isNaN(dismissed)) return true;
  return now.getTime() - dismissed >= CONNECT_NUDGE_SNOOZE_MS;
}

export function loadConnectNudgeDismissedAt(): string | null {
  try {
    return localStorage.getItem(CONNECT_NUDGE_KEY);
  } catch {
    return null;
  }
}

export function saveConnectNudgeDismissedAt(when: Date = new Date()): void {
  try {
    localStorage.setItem(CONNECT_NUDGE_KEY, when.toISOString());
  } catch {
    // Private mode or a full store: the banner simply comes back next launch.
  }
}
