import { spawn } from 'node:child_process';
import { Redactor, plainRedactor } from './redact';

/**
 * Running a command, in a way a worker can actually stop.
 *
 * Separate from the desktop's run service on purpose, for two reasons it
 * does not have to care about. The worker must be able to cancel an agent
 * that has spawned a build, which has spawned a test runner — killing the
 * child it knows about leaves that tree running and holding the checkout. And
 * it needs the output as a value rather than as a stream to a log panel.
 *
 * So every command runs in its own process group, and cancelling signals the
 * group. Everything else here is the care that needs: a timeout that also
 * kills the group, and output that is bounded, because a build loop can
 * produce gigabytes and the worker has to survive it.
 */

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Bytes kept per stream. The tail is what says why something failed. */
  maxOutputBytes?: number;
}

export interface CommandRunner {
  run(command: string, opts: RunOptions): Promise<CommandResult>;
}

const DEFAULT_TIMEOUT = 30 * 60_000;
const DEFAULT_MAX_OUTPUT = 512 * 1024;

/**
 * The last `max` characters of a stream, held as it arrives.
 *
 * Keep the tail: the reason a command failed is at the end of its output. It
 * used to keep every chunk and trim once the command ended — so a two-hour
 * agent run or a noisy build held all of its output in memory first, then
 * briefly twice over while joining it. This never holds more than about
 * twice `max`, however long the command runs.
 */
export class TailBuffer {
  private text = '';
  private truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max * 2) {
      this.text = this.text.slice(-this.max);
      this.truncated = true;
    }
  }

  toString(): string {
    if (!this.truncated && this.text.length <= this.max) return this.text;
    return `…${this.text.slice(-this.max)}`;
  }
}

export class ShellRunner implements CommandRunner {
  constructor(private readonly redactor: Redactor = plainRedactor) {}

  run(command: string, opts: RunOptions): Promise<CommandResult> {
    const started = Date.now();
    const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    return new Promise<CommandResult>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        // Its own process group, so cancelling reaches what it started.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const out = new TailBuffer(max);
      const err = new TailBuffer(max);
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          // Negative pid signals the whole group.
          process.kill(-child.pid, signal);
        } catch {
          // Already gone, which is the outcome being asked for.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        // A process that ignores SIGTERM still has to go.
        setTimeout(() => killGroup('SIGKILL'), 5_000).unref?.();
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

      const onAbort = () => {
        cancelled = true;
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 5_000).unref?.();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (d: Buffer) => out.push(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => err.push(d.toString('utf8')));

      // When the command itself ends, whatever it left running in its group
      // goes with it: a dev server or watcher an agent started in the
      // background otherwise kept its port and its hold on the worktree for
      // the life of the worker — and, holding stdout open, kept 'close' from
      // firing until the timeout, two hours for an agent.
      child.on('exit', () => killGroup('SIGKILL'));

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({
          code,
          stdout: this.redactor.redact(out.toString()),
          stderr: this.redactor.redact(err.toString()),
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
        });
      };

      child.on('error', (error) => {
        err.push(String(error.message));
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }
}

/**
 * A runner that answers from a script instead of running anything.
 *
 * Every test in this repository uses it. Nothing in the worker's own tests
 * spends agent credit or touches a real remote, and the only way to keep
 * that true is for the thing that would is injected.
 */
export class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string; env?: NodeJS.ProcessEnv }> = [];

  constructor(
    private readonly script: Array<{
      /** Matched against the command. */
      match: RegExp;
      result: Partial<CommandResult>;
      /** Answer at most this many times, then fall through to the next rule. */
      times?: number;
      /**
       * Matched against the directory the command runs in, when given.
       *
       * Every repository in an execution is checked with the same discovered
       * command, so the command alone cannot say "this suite is red and that
       * one is green" — and a worker whose whole job is several repositories
       * at once has to be testable in that state.
       */
      cwd?: RegExp;
    }> = []
  ) {}

  /** Add a rule at the front, so a later test can override an earlier setup. */
  when(
    match: RegExp,
    result: Partial<CommandResult>,
    opts?: number | { times?: number; cwd?: RegExp }
  ): this {
    const { times, cwd } =
      typeof opts === 'number' ? { times: opts, cwd: undefined } : (opts ?? {});
    this.script.unshift({
      match,
      result,
      ...(times === undefined ? {} : { times }),
      ...(cwd === undefined ? {} : { cwd }),
    });
    return this;
  }

  async run(command: string, opts: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });
    for (const rule of this.script) {
      if (!rule.match.test(command)) continue;
      if (rule.cwd && !rule.cwd.test(opts.cwd)) continue;
      if (rule.times !== undefined) {
        if (rule.times <= 0) continue;
        rule.times -= 1;
      }
      return {
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: 1,
        ...rule.result,
      };
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1 };
  }
}
