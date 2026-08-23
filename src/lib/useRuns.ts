import { useCallback, useEffect, useRef, useState } from 'react';
import { extractPrUrl, RunHandle } from './agentRunner';

export interface RunState {
  handle: RunHandle;
  log: string;
  running: boolean;
  exitCode: number | null;
  prUrl: string | null;
}

export interface RunsApi {
  runs: Record<string, RunState>;
  track(handle: RunHandle): void;
  stop(runId: string): void;
  latestForProject(projectId: string): RunState | null;
}

/** Tracks streamed output and exit status for every spawned run. */
export function useRuns(onRunFinished?: (run: RunState) => void): RunsApi {
  const [runs, setRuns] = useState<Record<string, RunState>>({});
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
      [handle.runId]: { handle, log: '', running: true, exitCode: null, prUrl: null },
    }));
  }, []);

  const stop = useCallback((runId: string) => {
    void window.mvpfy.stopRun(runId);
  }, []);

  const latestForProject = useCallback(
    (projectId: string): RunState | null => {
      const forProject = Object.values(runs).filter((r) => r.handle.projectId === projectId);
      return forProject.length > 0 ? forProject[forProject.length - 1] : null;
    },
    [runs]
  );

  return { runs, track, stop, latestForProject };
}
