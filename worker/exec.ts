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

/** Keep the tail: the reason a command failed is at the end of its output. */
function tail(chunks: string[], max: number): string {
  const joined = chunks.join('');
  return joined.length <= max ? joined : `…${joined.slice(-max)}`;
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

      const out: string[] = [];
      const err: string[] = [];
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

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({
          code,
          stdout: this.redactor.redact(tail(out, max)),
          stderr: this.redactor.redact(tail(err, max)),
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
  readonly calls: Array<{ command: string; cwd: string }> = [];

  constructor(
    private readonly script: Array<{
      /** Matched against the command. */
      match: RegExp;
      result: Partial<CommandResult>;
      /** Answer at most this many times, then fall through to the next rule. */
      times?: number;
    }> = []
  ) {}

  /** Add a rule at the front, so a later test can override an earlier setup. */
  when(match: RegExp, result: Partial<CommandResult>, times?: number): this {
    this.script.unshift({ match, result, ...(times === undefined ? {} : { times }) });
    return this;
  }

  async run(command: string, opts: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, cwd: opts.cwd });
    for (const rule of this.script) {
      if (!rule.match.test(command)) continue;
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
