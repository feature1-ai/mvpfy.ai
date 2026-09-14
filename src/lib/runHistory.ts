import type { RunState } from './useRuns';

const KEY = 'mvpfy.run-history.v1';
export const HISTORY_LIMIT = 40;
export const LOG_LIMIT = 40000;

/** Saved runs are display-only; never feed them into completion effects. */
export function mergeHistory(saved: RunState[], current: RunState[]): RunState[] {
  const byId = new Map(saved.map((run) => [run.handle.runId, run]));
  for (const run of current) byId.set(run.handle.runId, run);
  return [...byId.values()];
}

export function serializeHistory(runs: RunState[]): string {
  return JSON.stringify(
    runs
      .filter((run) => !run.running)
      .slice(-HISTORY_LIMIT)
      .map((run) => ({
        ...run,
        log: run.log.slice(-LOG_LIMIT),
      }))
  );
}

export function parseHistory(raw: string | null): RunState[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (run): run is RunState =>
          run &&
          typeof run === 'object' &&
          run.running === false &&
          typeof run.log === 'string' &&
          typeof run.handle?.runId === 'string' &&
          typeof run.handle?.projectId === 'string' &&
          typeof run.handle?.kind === 'string' &&
          (run.exitCode === null || Number.isInteger(run.exitCode))
      )
      .slice(-HISTORY_LIMIT)
      .map((run) => ({ ...run, log: run.log.slice(-LOG_LIMIT) }));
  } catch {
    return [];
  }
}

export function loadRunHistory(): RunState[] {
  try {
    return parseHistory(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveRunHistory(runs: RunState[]): void {
  // A full/disabled store must not prevent a run from finishing. Drop older
  // entries on quota errors, retaining the latest failure when possible.
  let retained = runs.filter((run) => !run.running).slice(-HISTORY_LIMIT);
  while (retained.length) {
    try {
      localStorage.setItem(KEY, serializeHistory(retained));
      return;
    } catch {
      retained = retained.slice(1);
    }
  }
}
