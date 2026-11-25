import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunOutputEvent } from '../../shared/types';
import { batchedOutput, beginSteppedRun, setRunEventSink, startRun, stopRun } from './runs';

afterEach(() => {
  vi.useRealTimers();
});

describe('batchedOutput', () => {
  it('sends many chunks as one message, after a short wait', () => {
    vi.useFakeTimers();
    const sent: RunOutputEvent[] = [];
    const out = batchedOutput('r1', (ev) => sent.push(ev), 33);
    for (let i = 0; i < 100; i++) out.push('stdout', `${i}\n`);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(33);
    expect(sent).toHaveLength(1);
    expect(sent[0].chunk.split('\n')).toHaveLength(101);
  });

  it('keeps stdout and stderr in the order they were printed', () => {
    vi.useFakeTimers();
    const sent: RunOutputEvent[] = [];
    const out = batchedOutput('r1', (ev) => sent.push(ev));
    out.push('stdout', 'a');
    out.push('stdout', 'b');
    out.push('stderr', 'c');
    out.push('stdout', 'd');
    out.flush();
    expect(sent.map((e) => [e.stream, e.chunk])).toEqual([
      ['stdout', 'ab'],
      ['stderr', 'c'],
      ['stdout', 'd'],
    ]);
  });

  it('sends everything at once when flushed, as an exit does', () => {
    const sent: RunOutputEvent[] = [];
    const out = batchedOutput('r1', (ev) => sent.push(ev), 10_000);
    out.push('stdout', 'https://github.com/acme/api/pull/7\n');
    out.flush();
    expect(sent).toEqual([
      { runId: 'r1', stream: 'stdout', chunk: 'https://github.com/acme/api/pull/7\n' },
    ]);
    out.flush();
    expect(sent).toHaveLength(1);
  });
});

describe('a stepped run', () => {
  /** Collect what a run sends, and resolve when it exits. */
  function watch(runId: string) {
    const output: RunOutputEvent[] = [];
    const exits: Array<number | null> = [];
    let finished!: () => void;
    const exited = new Promise<void>((resolve) => (finished = resolve));
    setRunEventSink({
      output: (ev) => {
        if (ev.runId === runId) output.push(ev);
      },
      exit: (ev) => {
        if (ev.runId !== runId) return;
        exits.push(ev.code);
        finished();
      },
    });
    const printed = () =>
      output
        .filter((e) => e.stream !== 'info')
        .map((e) => e.chunk)
        .join('');
    return { output, exits, exited, printed };
  }
  const cwd = process.cwd();

  /**
   * A step that behaves identically in cmd.exe and in a POSIX shell.
   *
   * These tests drive the real shell, which is the point of them — and the
   * reason they cannot be written in it. `a; b` is two commands to sh and one
   * literal string to cmd.exe, `sleep` and `/dev/zero` do not exist there, and
   * `echo one` prints `one\r\n` rather than `one\n`. Writing the steps in
   * JavaScript keeps the coverage on the platform whose shell is the risk,
   * instead of skipping it there. Single quotes only inside `js`: a double
   * quote would have to survive cmd.exe as well as node's own argument
   * parsing.
   */
  const step = (js: string) => `node -e ${JSON.stringify(js)}`;

  it('runs several commands under one id and exits once, at the end', async () => {
    const w = watch('stepped-1');
    const run = beginSteppedRun('stepped-1');
    expect((await run.step(step("console.log('one')"), cwd)).code).toBe(0);
    expect(w.exits).toEqual([]);
    expect((await run.step(step("console.log('two'); process.exit(3)"), cwd)).code).toBe(3);
    expect(w.exits).toEqual([]);
    run.end(0);
    await w.exited;
    expect(w.exits).toEqual([0]);
    expect(w.printed()).toBe('one\ntwo\n');
  }, 20_000); // Each step starts a node process, which takes seconds on a busy machine.

  it('sends a step’s output before the step resolves', async () => {
    const w = watch('stepped-2');
    const run = beginSteppedRun('stepped-2');
    await run.step('echo https://github.com/acme/api/pull/7', cwd);
    expect(w.printed()).toContain('pull/7');
    run.end(0);
  });

  it('puts mvpfy’s own lines in the same log', async () => {
    const w = watch('stepped-3');
    const run = beginSteppedRun('stepped-3');
    run.say('── Step 1 of 2 ──');
    run.end(0);
    expect(w.output.map((e) => e.chunk)).toContain('── Step 1 of 2 ──\n');
  });

  it('emits exactly one exit however often it is ended', async () => {
    const w = watch('stepped-4');
    const run = beginSteppedRun('stepped-4');
    run.end(1);
    run.end(0);
    run.say('too late');
    expect(w.exits).toEqual([1]);
    expect(w.output).toEqual([]);
  });

  it('refuses a second run under an id that is still going, stepped or not', () => {
    watch('stepped-5');
    const run = beginSteppedRun('stepped-5');
    expect(() => beginSteppedRun('stepped-5')).toThrow(/already active/);
    expect(() => startRun('stepped-5', 'echo no', cwd)).toThrow(/already active/);
    run.end(0);
    // Free again once it has ended.
    beginSteppedRun('stepped-5').end(0);
  });

  it('remembers being stopped between two commands, and starts nothing more', async () => {
    watch('stepped-6');
    const run = beginSteppedRun('stepped-6');
    await run.step(step("console.log('one')"), cwd);
    stopRun('stepped-6');
    expect(run.stopped()).toBe(true);
    expect((await run.step(step("console.log('should-not-run')"), cwd)).code).toBeNull();
    run.end(null);
  });

  it('stops the command in flight', async () => {
    watch('stepped-7');
    const run = beginSteppedRun('stepped-7');
    // A process that is genuinely alive for 30s. `sleep 30` was not one on
    // Windows — there is no such command, so the step failed to start and the
    // assertion below passed without anything having been stopped.
    const inFlight = run.step(step('setTimeout(function () {}, 30000)'), cwd);
    await new Promise((r) => setTimeout(r, 300));
    stopRun('stepped-7');
    expect((await inFlight).code).not.toBe(0);
    expect(run.stopped()).toBe(true);
    run.end(null);
  }, 15_000);

  it('hands back the start and the end of what a step printed, not the middle', async () => {
    watch('stepped-8');
    const run = beginSteppedRun('stepped-8');
    // JSON.stringify rather than a quoted literal: the first line has to come
    // out as {"type":…}, and a double quote inside the command would have to
    // survive cmd.exe too.
    const { output } = await run.step(
      step(
        "console.log(JSON.stringify({ type: 'thread.started', thread_id: 't-1' })); " +
          "console.log('x'.repeat(200000)); " +
          "console.log('No conversation found')"
      ),
      cwd
    );
    expect(output.startsWith('{"type":"thread.started"')).toBe(true);
    expect(output.trimEnd().endsWith('No conversation found')).toBe(true);
    expect(output.length).toBeLessThan(9000);
    run.end(0);
  });
});
