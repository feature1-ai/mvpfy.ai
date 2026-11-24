import { ChildProcess } from 'node:child_process';
import { RunExitEvent, RunOutputEvent } from '../../shared/types';
import { spawnEnv } from './docker';
import { killProcessTree, killProcessTrees, spawnShell } from './shell';

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
  onExit?: (code: number | null) => void,
  extraEnv?: NodeJS.ProcessEnv
): void {
  if (activeRuns.has(runId) || steppedRuns.has(runId)) {
    throw new Error(`Run ${runId} is already active`);
  }
  let cleaned = false;
  const cleanup = (code: number | null) => {
    if (cleaned) return;
    cleaned = true;
    try {
      onExit?.(code);
    } catch {
      // Cleanup is best effort; the startup sweep is the backstop.
    }
  };
  streamCommand(runId, command, cwd, extraEnv, (code) => {
    cleanup(code);
    sink.exit({ runId, code });
  });
}

/**
 * Spawn one command and stream what it prints under `runId`.
 *
 * `done` is called exactly once, however the command ended, after its last
 * output has been sent and it is no longer the run's active process. What
 * "the run is over" means is the caller's to decide: for a plain run it is
 * this command exiting; for a stepped run it is the last of several.
 */
function streamCommand(
  runId: string,
  command: string,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv | undefined,
  done: (code: number | null) => void,
  /** Sees everything the command prints, as well as the window. */
  tap?: (chunk: string) => void
): void {
  sink.output({ runId, stream: 'info', chunk: `$ ${command}\n` });
  const child = spawnShell(command, { cwd, env: { ...spawnEnv(), ...extraEnv } });
  activeRuns.set(runId, child);

  const output = batchedOutput(runId, (ev) => sink.output(ev));
  const forward = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
    const chunk = data.toString('utf8');
    tap?.(chunk);
    output.push(stream, chunk);
  };
  child.stdout?.on('data', forward('stdout'));
  child.stderr?.on('data', forward('stderr'));
  // Every way a run can end has to emit an exit, exactly once. A shell that
  // cannot be spawned used to report the error and stop there, so anything
  // awaiting the run waited for an event that was never coming — and a caller
  // that blocks on completion leaves the run marked as still going, which
  // disables the whole project until the app is restarted.
  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    // Everything the run printed reaches the renderer before its exit does:
    // the last lines carry the PR URL and the codex thread id.
    output.flush();
    activeRuns.delete(runId);
    done(code);
  };
  child.on('error', (err) => {
    output.flush();
    sink.output({ runId, stream: 'stderr', chunk: `spawn error: ${err.message}\n` });
    finish(null);
  });
  child.on('close', (code) => finish(code));
}

/**
 * A run made of several commands, one after another, that the window sees as
 * one: a single id, one continuous log, and one exit when the last is done.
 *
 * It exists so that long agent work can be done as short checked steps
 * (shared/unitRunner.ts) without every screen that watches "the setup run"
 * having to learn that it became five. Stopping it stops the command in
 * flight and is remembered, so whatever is deciding the next step can see
 * that there should not be one.
 */
const steppedRuns = new Map<string, { stopped: boolean }>();

/** How one command of a stepped run ended. */
export interface StepResult {
  code: number | null;
  /**
   * The start and the end of what it printed. The start is where an agent
   * announces the conversation it opened; the end is where it says why it
   * could not continue one. The middle can be megabytes and is not kept.
   */
  output: string;
}

/** Enough of each end to find a conversation id or a refusal, and no more. */
const STEP_OUTPUT_EDGE = 4000;

export interface SteppedRun {
  /** Run one command to completion. Resolves with how it ended; never rejects. */
  step(command: string, cwd: string, extraEnv?: NodeJS.ProcessEnv): Promise<StepResult>;
  /** A line of mvpfy's own, in the run's log. */
  say(text: string, stream?: 'info' | 'stderr'): void;
  /** True once somebody asked for this run to stop. */
  stopped(): boolean;
  /** The run is over. Emits its one exit; anything after is ignored. */
  end(code: number | null): void;
}

export function beginSteppedRun(runId: string): SteppedRun {
  if (activeRuns.has(runId) || steppedRuns.has(runId)) {
    throw new Error(`Run ${runId} is already active`);
  }
  const state = { stopped: false };
  steppedRuns.set(runId, state);
  let ended = false;
  return {
    step: (command, cwd, extraEnv) =>
      new Promise((resolve) => {
        if (ended || state.stopped) return resolve({ code: null, output: '' });
        let head = '';
        let rest = '';
        const tap = (chunk: string) => {
          if (head.length < STEP_OUTPUT_EDGE) {
            head += chunk;
            if (head.length <= STEP_OUTPUT_EDGE) return;
            chunk = head.slice(STEP_OUTPUT_EDGE);
            head = head.slice(0, STEP_OUTPUT_EDGE);
          }
          rest = (rest + chunk).slice(-STEP_OUTPUT_EDGE);
        };
        try {
          streamCommand(
            runId,
            command,
            cwd,
            extraEnv,
            (code) => resolve({ code, output: rest ? `${head}\n${rest}` : head }),
            tap
          );
        } catch (error) {
          activeRuns.delete(runId);
          sink.output({
            runId,
            stream: 'stderr',
            chunk: `spawn error: ${(error as Error).message}\n`,
          });
          resolve({ code: null, output: '' });
        }
      }),
    say: (text, stream = 'info') => {
      if (!ended) sink.output({ runId, stream, chunk: text.endsWith('\n') ? text : `${text}\n` });
    },
    stopped: () => state.stopped,
    end: (code) => {
      if (ended) return;
      ended = true;
      steppedRuns.delete(runId);
      sink.exit({ runId, code });
    },
  };
}

/** How long output is gathered before it crosses to the renderer. */
export const OUTPUT_BATCH_MS = 33;

/**
 * Output for one run, sent in batches rather than one IPC message per chunk.
 *
 * An agent streaming JSON or `docker logs -f` produces chunks by the hundred
 * a second, and each was its own message across the process boundary. The
 * order is kept exactly — adjacent chunks of the same stream are joined, a
 * switch between stdout and stderr starts a new message — so the log reads
 * the same; it just arrives in a few dozen messages a second at most.
 */
export function batchedOutput(
  runId: string,
  emit: (ev: RunOutputEvent) => void,
  delayMs: number = OUTPUT_BATCH_MS
): { push(stream: 'stdout' | 'stderr', chunk: string): void; flush(): void } {
  let pending: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = pending;
    pending = [];
    for (const { stream, chunk } of batch) emit({ runId, stream, chunk });
  };
  return {
    push(stream, chunk) {
      const last = pending[pending.length - 1];
      if (last && last.stream === stream) last.chunk += chunk;
      else pending.push({ stream, chunk });
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}

export function stopRun(runId: string): void {
  // Remembered first: a stepped run between two commands has nothing to kill,
  // and would otherwise go on to start the next one.
  const stepped = steppedRuns.get(runId);
  if (stepped) stepped.stopped = true;
  killProcessTree(activeRuns.get(runId));
}

export function stopAllRuns(): void {
  for (const stepped of steppedRuns.values()) stepped.stopped = true;
  killProcessTrees([...activeRuns.values()]);
}
