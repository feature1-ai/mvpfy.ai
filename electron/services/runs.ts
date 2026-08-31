import { ChildProcess } from 'node:child_process';
import { RunExitEvent, RunOutputEvent } from '../../shared/types';
import { spawnEnv } from './docker';
import { spawnShell } from './shell';

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
 */
export function startRun(runId: string, command: string, cwd: string, onExit?: () => void): void {
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
  const child = spawnShell(command, { cwd, env: spawnEnv() });
  activeRuns.set(runId, child);

  child.stdout?.on('data', (data: Buffer) => {
    sink.output({ runId, stream: 'stdout', chunk: data.toString('utf8') });
  });
  child.stderr?.on('data', (data: Buffer) => {
    sink.output({ runId, stream: 'stderr', chunk: data.toString('utf8') });
  });
  child.on('error', (err) => {
    sink.output({ runId, stream: 'stderr', chunk: `spawn error: ${err.message}\n` });
    cleanup();
  });
  child.on('close', (code) => {
    activeRuns.delete(runId);
    cleanup();
    sink.exit({ runId, code });
  });
}

export function stopRun(runId: string): void {
  activeRuns.get(runId)?.kill('SIGTERM');
}

export function stopAllRuns(): void {
  for (const child of activeRuns.values()) {
    child.kill('SIGTERM');
  }
}
