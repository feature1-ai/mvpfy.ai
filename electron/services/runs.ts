import { ChildProcess } from 'node:child_process';
import { RunExitEvent, RunOutputEvent } from '../../shared/types';
import { spawnEnv } from './docker';
import { killProcessTree, spawnShell } from './shell';

/**
 * Streaming command runner. Decoupled from the window via an injected event
 * sink (dependency inversion) so this service has no Electron UI imports.
 */

export interface RunEventSink {
  output(ev: RunOutputEvent): void;
  exit(ev: RunExitEvent): void;
}

let sink: RunEventSink = { output: () => {}, exit: () => {} };
const activeRuns = new Map<string, ChildProcess>();

export function setRunEventSink(next: RunEventSink): void {
  sink = next;
}

/**
 * `onExit` runs once when the process is gone, however it ended. Callers use
 * it to delete per-run scratch files — some of which hold credentials.
 *
 * `extraEnv` is merged over the run environment. Prefer it to a `VAR=value`
 * prefix on the command: that syntax is POSIX-only, and it would also print
 * the value into the run log along with the command.
 */
export function startRun(
  runId: string,
  command: string,
  cwd: string,
  onExit?: () => void,
  extraEnv?: NodeJS.ProcessEnv
): void {
  if (activeRuns.has(runId)) {
    throw new Error(`Run ${runId} is already active`);
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      onExit?.();
    } catch {
      // Cleanup is best effort; the startup sweep is the backstop.
    }
  };
  sink.output({ runId, stream: 'info', chunk: `$ ${command}\n` });
  const child = spawnShell(command, { cwd, env: { ...spawnEnv(), ...extraEnv } });
  activeRuns.set(runId, child);

  child.stdout?.on('data', (data: Buffer) => {
    sink.output({ runId, stream: 'stdout', chunk: data.toString('utf8') });
  });
  child.stderr?.on('data', (data: Buffer) => {
    sink.output({ runId, stream: 'stderr', chunk: data.toString('utf8') });
  });
  // Every way a run can end has to emit an exit, exactly once. A shell that
  // cannot be spawned used to report the error and stop there, so anything
  // awaiting the run waited for an event that was never coming — and a caller
  // that blocks on completion leaves the run marked as still going, which
  // disables the whole project until the app is restarted.
  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    activeRuns.delete(runId);
    cleanup();
    sink.exit({ runId, code });
  };
  child.on('error', (err) => {
    sink.output({ runId, stream: 'stderr', chunk: `spawn error: ${err.message}\n` });
    finish(null);
  });
  child.on('close', (code) => finish(code));
}

export function stopRun(runId: string): void {
  killProcessTree(activeRuns.get(runId));
}

export function stopAllRuns(): void {
  for (const child of activeRuns.values()) {
    killProcessTree(child);
  }
}
