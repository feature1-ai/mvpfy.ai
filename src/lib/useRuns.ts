import { useCallback, useEffect, useRef, useState } from 'react';
import { extractPrUrl, RunHandle } from './agentRunner';
import { loadRunHistory, mergeHistory, saveRunHistory } from './runHistory';

export interface RunState {
  handle: RunHandle;
  log: string;
  running: boolean;
  exitCode: number | null;
  prUrl: string | null;
  startedAt?: string;
}

export interface RunsApi {
  runs: Record<string, RunState>;
  /** Display history, including completed runs from previous sessions. */
  history: RunState[];
  track(handle: RunHandle): void;
  fail(runId: string, message: string): void;
  /**
   * Resolves with the exit code when this run ends.
   *
   * For sequences that must not overlap — pull, then merge, then check out —
   * where launching the next step before the last one finished would have two
   * git commands writing one repository.
   */
  completed(runId: string): Promise<number | null>;
  stop(runId: string): void;
  latestForProject(projectId: string): RunState | null;
}

/** Tracks streamed output and exit status for every spawned run. */
export function useRuns(onRunFinished?: (run: RunState) => void): RunsApi {
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [saved] = useState(loadRunHistory);
  const history = mergeHistory(saved, Object.values(runs));
  const savedSignature = useRef('');
  useEffect(() => {
    const signature = Object.values(runs)
      .filter((run) => !run.running)
      .map((run) => `${run.handle.runId}:${run.exitCode}:${run.log.length}`)
      .join('|');
    if (signature === savedSignature.current) return;
    savedSignature.current = signature;
    saveRunHistory(mergeHistory(saved, Object.values(runs)));
  }, [runs, saved]);
  const finishedCb = useRef(onRunFinished);
  useEffect(() => {
    finishedCb.current = onRunFinished;
  }, [onRunFinished]);

  useEffect(() => {
    const offOutput = window.mvpfy.onRunOutput((ev) => {
      setRuns((prev) => {
        const run = prev[ev.runId];
        if (!run) return prev;
        // Cap retained log size — follow-mode streams run indefinitely.
        return { ...prev, [ev.runId]: { ...run, log: (run.log + ev.chunk).slice(-200_000) } };
      });
    });
    const offExit = window.mvpfy.onRunExit((ev) => {
      finishedCodes.current.set(ev.runId, ev.code);
      const waiters = waiting.current.get(ev.runId);
      if (waiters) {
        waiting.current.delete(ev.runId);
        for (const resolve of waiters) resolve(ev.code);
      }
      setRuns((prev) => {
        const run = prev[ev.runId];
        if (!run) return prev;
        const finished: RunState = {
          ...run,
          running: false,
          exitCode: ev.code,
          prUrl:
            run.handle.kind === 'ship' || run.handle.kind === 'plan-story'
              ? extractPrUrl(run.log)
              : null,
        };
        queueMicrotask(() => finishedCb.current?.(finished));
        return { ...prev, [ev.runId]: finished };
      });
    });
    return () => {
      offOutput();
      offExit();
    };
  }, []);

  const track = useCallback((handle: RunHandle) => {
    setRuns((prev) => ({
      ...prev,
      [handle.runId]: {
        handle,
        log: '',
        running: true,
        exitCode: null,
        prUrl: null,
        startedAt: new Date().toISOString(),
      },
    }));
  }, []);

  // Resolved by the exit listener below; a run that has already finished
  // resolves at once, so a caller that arrives late is not left waiting.
  const waiting = useRef(new Map<string, Array<(code: number | null) => void>>());
  const finishedCodes = useRef(new Map<string, number | null>());
  const completed = useCallback((runId: string): Promise<number | null> => {
    if (finishedCodes.current.has(runId)) {
      return Promise.resolve(finishedCodes.current.get(runId) ?? null);
    }
    return new Promise((resolve) => {
      const list = waiting.current.get(runId) ?? [];
      list.push(resolve);
      waiting.current.set(runId, list);
    });
  }, []);

  const stop = useCallback((runId: string) => {
    void window.mvpfy.stopRun(runId);
  }, []);

  const fail = useCallback((runId: string, message: string) => {
    setRuns((prev) => {
      const run = prev[runId];
      if (!run) return prev;
      return {
        ...prev,
        [runId]: { ...run, running: false, exitCode: 1, log: run.log + message + '\n' },
      };
    });
  }, []);

  const latestForProject = useCallback(
    (projectId: string): RunState | null => {
      const forProject = Object.values(runs).filter((r) => r.handle.projectId === projectId);
      return forProject.length > 0 ? forProject[forProject.length - 1] : null;
    },
    [runs]
  );

  return { runs, history, track, fail, completed, stop, latestForProject };
}
