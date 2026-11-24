import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { CommandResult, CommandRunner } from './exec';

/**
 * The sandbox: where code the worker did not write is run.
 *
 * The agent runs with its permission checks off, and verification runs the
 * repository's own scripts. childEnv.ts takes the worker's credentials out of
 * their environment, and says itself that this is a narrowing: a process
 * running as the same user in the same place can read the worker's files and
 * its /proc.
 *
 * This is what closes that. `sandbox` runs this server in a second container
 * that shares the worker's checkouts and nothing else — no GitHub sign-in, no
 * runner credential. The worker sends it the agent's command and the checks
 * (remoteRunner.ts) and keeps git push, gh and Feature1 for itself. What runs
 * here can read everything here, and there is nothing of the worker's here to
 * read.
 *
 * The token is not what protects the worker. It stops anything else on the
 * network from running commands in this tenant's checkouts. Code already
 * running in the sandbox can read it, and gains only the ability to run more
 * code in the sandbox.
 */

export const RUN_PATH = '/run';
export const CANCEL_PATH = '/cancel';
export const HEALTH_PATH = '/health';

/** What the worker asks the sandbox to run. */
export interface RunRequest {
  /** Chosen by the worker, so it can cancel this run and no other. */
  id: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxServerConfig {
  token: string;
  port: number;
  /** Commands run under this directory and nowhere else. */
  root: string;
}

const MIN_TOKEN = 32;

export function sandboxTokenFrom(env: NodeJS.ProcessEnv): string {
  const token = (env.MVPFY_SANDBOX_TOKEN ?? '').trim();
  if (token.length < MIN_TOKEN) {
    throw new Error(`MVPFY_SANDBOX_TOKEN must be at least ${MIN_TOKEN} characters of randomness`);
  }
  return token;
}

export function sandboxServerConfigFrom(env: NodeJS.ProcessEnv, root: string): SandboxServerConfig {
  const port = Number((env.MVPFY_SANDBOX_PORT ?? '7070').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MVPFY_SANDBOX_PORT must be a port number');
  }
  return { token: sandboxTokenFrom(env), port, root };
}

/** Compared in constant time, and by digest so lengths need not match. */
function sameToken(given: string, expected: string): boolean {
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function isInside(root: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The request, or the reason it is refused. Nothing is run on a guess. */
export function parseRunRequest(raw: unknown, root: string): RunRequest | string {
  if (!raw || typeof raw !== 'object') return 'The request must be a JSON object';
  const { id, command, cwd, env, timeoutMs, maxOutputBytes } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return 'id is not usable';
  if (typeof command !== 'string' || !command.trim()) return 'command is missing';
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !isInside(root, cwd)) {
    return `cwd must be a directory under ${root}`;
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return 'env must be an object';
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') return `env.${key} is not a string`;
    cleanEnv[key] = value;
  }
  const positive = (value: unknown) =>
    value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
  if (!positive(timeoutMs) || !positive(maxOutputBytes)) return 'A limit is not a positive number';
  return {
    id,
    command,
    cwd,
    env: cleanEnv,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes: maxOutputBytes as number }),
  };
}

const MAX_BODY = 4 * 1024 * 1024;
/** Sent while a command runs, so a silent connection means a dead one. */
export const HEARTBEAT_MS = 15_000;

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('The request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('The request is not JSON'));
      }
    });
  });
}

export class SandboxServer {
  private readonly running = new Map<string, AbortController>();
  private server: http.Server | null = null;

  constructor(
    private readonly config: SandboxServerConfig,
    private readonly runner: CommandRunner,
    private readonly log: (message: string) => void = () => {},
    private readonly heartbeatMs: number = HEARTBEAT_MS
  ) {}

  /** Resolves with the port it is listening on. */
  listen(host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((error: Error) => {
          if (!res.headersSent) this.refuse(res, 400, error.message);
          else res.end();
        });
      });
      // A command runs for as long as an agent takes; nothing here may give up first.
      server.requestTimeout = 0;
      server.timeout = 0;
      server.once('error', reject);
      server.listen(this.config.port, host, () => {
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  /** Stops listening and cancels whatever is running. */
  close(): Promise<void> {
    for (const controller of this.running.values()) controller.abort();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private refuse(res: http.ServerResponse, status: number, error: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
  }

  private authorised(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return sameToken(given, this.config.token);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorised(req)) return this.refuse(res, 401, 'Not authorised');
    const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    if (route === `GET ${HEALTH_PATH}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running: this.running.size }));
      return;
    }
    if (route === `POST ${CANCEL_PATH}`) {
      const { id } = ((await readJson(req)) ?? {}) as { id?: unknown };
      const controller = typeof id === 'string' ? this.running.get(id) : undefined;
      controller?.abort();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cancelled: Boolean(controller) }));
      return;
    }
    if (route === `POST ${RUN_PATH}`) return this.run(await readJson(req), res);
    this.refuse(res, 404, 'No such route');
  }

  private async run(raw: unknown, res: http.ServerResponse): Promise<void> {
    const request = parseRunRequest(raw, this.config.root);
    if (typeof request === 'string') return this.refuse(res, 400, request);
    if (this.running.has(request.id)) return this.refuse(res, 409, 'That id is already running');

    const controller = new AbortController();
    this.running.set(request.id, controller);
    // The worker going away — crashed, replaced, cancelled without saying so —
    // must not leave an agent running here with nobody to report to.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    // Headers now, the result when there is one. A blank line in between is
    // a heartbeat: it is how the worker tells a long build from a dead peer.
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('\n');
    const heartbeat = setInterval(() => res.write('\n'), this.heartbeatMs);
    this.log(`run ${request.id} started in ${request.cwd}`);
    let result: CommandResult;
    try {
      result = await this.runner.run(request.command, {
        cwd: request.cwd,
        // The worker's choice of environment and nothing of this process's,
        // so the sandbox's own token is not handed to what it runs.
        env: request.env,
        signal: controller.signal,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.maxOutputBytes ? { maxOutputBytes: request.maxOutputBytes } : {}),
      });
    } finally {
      clearInterval(heartbeat);
      this.running.delete(request.id);
    }
    this.log(
      `run ${request.id} ended: ${result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : `exit ${result.code}`}`
    );
    res.end(`${JSON.stringify(result)}\n`);
  }
}
