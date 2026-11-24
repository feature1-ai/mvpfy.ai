import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { CommandResult, CommandRunner, RunOptions } from './exec';
import { Redactor, plainRedactor } from './redact';
import {
  CANCEL_PATH,
  HEALTH_PATH,
  HEARTBEAT_MS,
  RUN_PATH,
  RunRequest,
  sandboxTokenFrom,
} from './sandbox';

/**
 * A command runner that runs nothing here.
 *
 * It sends the command to the sandbox (sandbox.ts) and returns what came
 * back, so the agent runner and the verifier — which take any CommandRunner —
 * need not know their commands left the container. The worker's own git and
 * gh keep the local runner: those are the commands that carry a token, and
 * the point of the sandbox is that the token never goes there.
 */

export interface SandboxClientConfig {
  /** For example http://mvpfy-sandbox-acme:7070 */
  url: string;
  token: string;
}

/** The sandbox this worker was given, or null when it runs everything itself. */
export function sandboxClientFrom(env: NodeJS.ProcessEnv): SandboxClientConfig | null {
  const raw = (env.MVPFY_SANDBOX_URL ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MVPFY_SANDBOX_URL is not an address: ${JSON.stringify(raw)}`);
  }
  // Plain http on purpose: the sandbox is the container next door on a
  // network nothing else is attached to, not somewhere across the internet.
  if (url.protocol !== 'http:') throw new Error('MVPFY_SANDBOX_URL must be an http:// address');
  return { url: url.origin, token: sandboxTokenFrom(env) };
}

/**
 * What must never be sent, whatever the caller put in the environment: the
 * credentials the worker acts with. Named one by one rather than by prefix,
 * because the agent's own Feature1 MCP token is meant to cross and shares one.
 */
const NEVER_CROSSES = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'MVPFY_RUNNER_TOKEN',
  'MVPFY_GIT_PASSWORD',
  'MVPFY_SANDBOX_TOKEN',
]);

/** The environment a command is sent with. */
export function crossingEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && !NEVER_CROSSES.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

function failed(message: string, started: number, cancelled = false): CommandResult {
  return {
    code: null,
    stdout: '',
    stderr: message,
    timedOut: false,
    cancelled,
    durationMs: Date.now() - started,
  };
}

function isResult(value: unknown): value is CommandResult {
  const v = value as Record<string, unknown> | null;
  return (
    !!v &&
    (v.code === null || typeof v.code === 'number') &&
    typeof v.stdout === 'string' &&
    typeof v.stderr === 'string' &&
    typeof v.timedOut === 'boolean' &&
    typeof v.cancelled === 'boolean'
  );
}

export class RemoteRunner implements CommandRunner {
  constructor(
    private readonly config: SandboxClientConfig,
    private readonly redactor: Redactor = plainRedactor,
    /** How long the sandbox may say nothing before it is taken for dead. */
    private readonly silenceMs: number = HEARTBEAT_MS * 6
  ) {}

  private post(path: string, body: unknown, method = 'POST'): http.ClientRequest {
    const payload = method === 'GET' ? '' : JSON.stringify(body);
    const req = http.request(`${this.config.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        ...(method === 'GET'
          ? {}
          : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    });
    req.end(payload);
    return req;
  }

  /** Waits for the sandbox to answer, since the two containers start together. */
  async ready(withinMs = 30_000): Promise<void> {
    const deadline = Date.now() + withinMs;
    for (;;) {
      const outcome = await new Promise<string | null>((resolve) => {
        const req = this.post(HEALTH_PATH, null, 'GET');
        req.setTimeout(5_000, () => req.destroy(new Error('no answer in 5s')));
        req.on('error', (error) => resolve(error.message));
        req.on('response', (res) => {
          res.resume();
          resolve(res.statusCode === 200 ? null : `it answered ${res.statusCode}`);
        });
      });
      if (outcome === null) return;
      // A wrong token will not come right by waiting.
      if (outcome === 'it answered 401' || Date.now() >= deadline) {
        throw new Error(`The sandbox at ${this.config.url} is not usable: ${outcome}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  run(command: string, opts: RunOptions): Promise<CommandResult> {
    const started = Date.now();
    // Whatever the caller chose, the worker's own credentials do not cross.
    const env = crossingEnv(opts.env ?? process.env);
    const request: RunRequest = {
      id: crypto.randomBytes(12).toString('hex'),
      command,
      cwd: opts.cwd,
      env,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxOutputBytes ? { maxOutputBytes: opts.maxOutputBytes } : {}),
    };

    return new Promise<CommandResult>((resolve) => {
      let settled = false;
      let cancelled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({
          ...result,
          stdout: this.redactor.redact(result.stdout),
          stderr: this.redactor.redact(result.stderr),
        });
      };

      const req = this.post(RUN_PATH, request);
      // Asked to stop, and then waited for: the result that comes back says
      // the command and everything it started are gone, which is what lets
      // the worker touch the checkout again.
      const onAbort = () => {
        cancelled = true;
        const cancel = this.post(CANCEL_PATH, { id: request.id });
        cancel.on('error', () =>
          req.destroy(new Error('cancelled, and the sandbox did not answer'))
        );
        cancel.on('response', (res) => res.resume());
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });

      req.setTimeout(this.silenceMs, () =>
        req.destroy(new Error(`nothing from the sandbox for ${Math.round(this.silenceMs / 1000)}s`))
      );
      req.on('error', (error) =>
        finish(failed(`The sandbox connection was lost: ${error.message}`, started, cancelled))
      );
      req.on('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          // Heartbeats are blank lines; keep only what could be the result.
          body = (body + chunk).replace(/^\n+/, '');
        });
        res.on('error', (error) =>
          finish(failed(`The sandbox connection was lost: ${error.message}`, started, cancelled))
        );
        res.on('end', () => {
          if (res.statusCode !== 200) {
            let reason = body.trim();
            try {
              reason = (JSON.parse(body) as { error?: string }).error ?? reason;
            } catch {
              // Not JSON; say what it did send.
            }
            return finish(
              failed(`The sandbox refused the command (${res.statusCode}): ${reason}`, started)
            );
          }
          try {
            const parsed: unknown = JSON.parse(body.trim());
            if (isResult(parsed)) return finish({ ...parsed, durationMs: Date.now() - started });
          } catch {
            // Falls through to the message below.
          }
          finish(failed('The sandbox ended the connection without a result', started, cancelled));
        });
      });
    });
  }
}
