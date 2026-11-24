import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commandFrom, secretsDirFrom } from './config';
import { CommandResult, CommandRunner, RunOptions, ShellRunner } from './exec';
import { Redactor } from './redact';
import { RemoteRunner, crossingEnv, sandboxClientFrom } from './remoteRunner';
import { SandboxServer, parseRunRequest, sandboxServerConfigFrom } from './sandbox';

const TOKEN = 'sandbox-token-'.padEnd(40, 'x');
// The worker runs on Linux and macOS and says so at start-up. What these check
// is about directories under a root, which on Windows are not spelt this way.
const POSIX = process.platform !== 'win32';

describe.runIf(POSIX)('what the sandbox will run', () => {
  const root = '/var/lib/mvpfy';
  const ok = { id: 'abcdef123456', command: 'npm test', cwd: `${root}/executions/a`, env: {} };

  it('takes a command, a directory under its root and an environment', () => {
    expect(parseRunRequest({ ...ok, env: { PATH: '/usr/bin' }, timeoutMs: 1000 }, root)).toEqual({
      ...ok,
      env: { PATH: '/usr/bin' },
      timeoutMs: 1000,
    });
  });

  it.each([
    ['a directory outside its root', { ...ok, cwd: '/etc' }],
    ['a directory that climbs out of it', { ...ok, cwd: `${root}/../../etc` }],
    ['a neighbour that only shares a prefix', { ...ok, cwd: `${root}-secrets` }],
    ['a relative directory', { ...ok, cwd: 'executions/a' }],
    ['no command', { ...ok, command: '  ' }],
    ['an id that could be anything', { ...ok, id: '../x' }],
    ['an environment that is not strings', { ...ok, env: { A: 1 } }],
    ['a limit that is not a number', { ...ok, timeoutMs: 'soon' }],
    ['something that is not a request', 'npm test'],
  ])('refuses %s', (_name, request) => {
    expect(typeof parseRunRequest(request, root)).toBe('string');
  });
});

describe('what crosses to the sandbox', () => {
  it("is never one of the worker's own credentials", () => {
    const sent = crossingEnv({
      PATH: '/usr/bin',
      GH_TOKEN: 'gho_worker',
      GITHUB_TOKEN: 'gho_worker',
      MVPFY_RUNNER_TOKEN: 'a'.repeat(64),
      MVPFY_GIT_PASSWORD: 'gho_worker',
      MVPFY_SANDBOX_TOKEN: TOKEN,
      // The agent's own, read-only by its scope: this one is meant to arrive.
      MVPFY_FEATURE1_TOKEN: 'mcp_read_only',
      ANTHROPIC_API_KEY: 'sk-agent',
    });
    expect(sent).toEqual({
      PATH: '/usr/bin',
      MVPFY_FEATURE1_TOKEN: 'mcp_read_only',
      ANTHROPIC_API_KEY: 'sk-agent',
    });
  });
});

describe('how a worker is told about its sandbox', () => {
  it('runs everything itself when it has none', () => {
    expect(sandboxClientFrom({})).toBeNull();
  });

  it('needs an address and a token together', () => {
    expect(
      sandboxClientFrom({ MVPFY_SANDBOX_URL: 'http://sandbox:7070/', MVPFY_SANDBOX_TOKEN: TOKEN })
    ).toEqual({ url: 'http://sandbox:7070', token: TOKEN });
    expect(() => sandboxClientFrom({ MVPFY_SANDBOX_URL: 'http://sandbox:7070' })).toThrow(
      /MVPFY_SANDBOX_TOKEN/
    );
    expect(() =>
      sandboxClientFrom({ MVPFY_SANDBOX_URL: 'sandbox:7070', MVPFY_SANDBOX_TOKEN: TOKEN })
    ).toThrow(/http:\/\//);
  });

  it('will not serve with a token short enough to guess', () => {
    expect(() => sandboxServerConfigFrom({ MVPFY_SANDBOX_TOKEN: 'short' }, '/w')).toThrow();
    expect(sandboxServerConfigFrom({ MVPFY_SANDBOX_TOKEN: TOKEN }, '/w').port).toBe(7070);
  });

  it('has its own command, and keeps the runner credential where it is told to', () => {
    expect(commandFrom(['node', 'index.js', 'sandbox'])).toBe('sandbox');
    expect(() => commandFrom(['node', 'index.js', 'sandbox', '--port'])).toThrow(/Unrecognised/);
    expect(secretsDirFrom({ MVPFY_WORKER_ROOT: '/w' })).toBe('/w');
    expect(secretsDirFrom({ MVPFY_WORKER_ROOT: '/w', MVPFY_SECRETS_DIR: '/s' })).toBe('/s');
    expect(() => secretsDirFrom({ MVPFY_SECRETS_DIR: 'relative' })).toThrow(/absolute/);
  });
});

/** Records what it was asked, and answers when the test says. */
class HeldRunner implements CommandRunner {
  calls: Array<{ command: string; opts: RunOptions }> = [];
  release: (result: Partial<CommandResult>) => void = () => {};

  run(command: string, opts: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, opts });
    return new Promise((resolve) => {
      const done = (result: Partial<CommandResult>) =>
        resolve({
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          ...result,
        });
      this.release = done;
      opts.signal?.addEventListener('abort', () => done({ code: null, cancelled: true }));
    });
  }
}

describe.runIf(POSIX)('a worker and its sandbox, over a real connection', () => {
  const open: SandboxServer[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((server) => server.close()));
  });

  async function pair(runner: CommandRunner, root: string, redactor = new Redactor()) {
    const server = new SandboxServer({ token: TOKEN, port: 0, root }, runner, () => {}, 20);
    open.push(server);
    const port = await server.listen('127.0.0.1');
    const url = `http://127.0.0.1:${port}`;
    return { url, remote: new RemoteRunner({ url, token: TOKEN }, redactor, 2_000) };
  }

  it('sends the command, directory and environment, and returns the result', async () => {
    const held = new HeldRunner();
    const { remote } = await pair(held, '/work');
    const pending = remote.run('npm test', {
      cwd: '/work/a',
      env: { PATH: '/bin', GH_TOKEN: 'gho_worker' },
      timeoutMs: 5_000,
    });
    await expect.poll(() => held.calls.length).toBe(1);
    expect(held.calls[0]?.command).toBe('npm test');
    expect(held.calls[0]?.opts.cwd).toBe('/work/a');
    expect(held.calls[0]?.opts.env).toEqual({ PATH: '/bin' });
    expect(held.calls[0]?.opts.timeoutMs).toBe(5_000);
    held.release({ code: 3, stdout: 'out', stderr: 'err' });
    expect(await pending).toMatchObject({
      code: 3,
      stdout: 'out',
      stderr: 'err',
      cancelled: false,
    });
  });

  it('waits through a long run on heartbeats alone', async () => {
    const held = new HeldRunner();
    const { remote } = await pair(held, '/work');
    const pending = remote.run('long build', { cwd: '/work' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    held.release({ stdout: 'done at last' });
    expect((await pending).stdout).toBe('done at last');
  });

  it('redacts what comes back, with what only the worker knows', async () => {
    const held = new HeldRunner();
    const { remote } = await pair(held, '/work', new Redactor().remember('gho_secret_token_value'));
    const pending = remote.run('env', { cwd: '/work' });
    await expect.poll(() => held.calls.length).toBe(1);
    held.release({ stdout: 'leaked gho_secret_token_value here' });
    expect((await pending).stdout).not.toContain('gho_secret_token_value');
  });

  it('cancels in the sandbox, and waits to hear that it stopped', async () => {
    const held = new HeldRunner();
    const { remote } = await pair(held, '/work');
    const controller = new AbortController();
    const pending = remote.run('agent', { cwd: '/work', signal: controller.signal });
    await expect.poll(() => held.calls.length).toBe(1);
    controller.abort();
    expect(await pending).toMatchObject({ code: null, cancelled: true });
    expect(held.calls[0]?.opts.signal?.aborted).toBe(true);
  });

  it('stops the command when the worker goes away without a word', async () => {
    const held = new HeldRunner();
    const { url } = await pair(held, '/work');
    const controller = new AbortController();
    const gone = fetch(`${url}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'abcdef123456', command: 'agent', cwd: '/work', env: {} }),
      signal: controller.signal,
    }).catch(() => null);
    await expect.poll(() => held.calls.length).toBe(1);
    controller.abort();
    await gone;
    await expect.poll(() => held.calls[0]?.opts.signal?.aborted).toBe(true);
  });

  it('reports a sandbox that died mid-run as a failure, not a hang', async () => {
    const held = new HeldRunner();
    const server = new SandboxServer({ token: TOKEN, port: 0, root: '/work' }, held, () => {}, 20);
    const port = await server.listen('127.0.0.1');
    const remote = new RemoteRunner({ url: `http://127.0.0.1:${port}`, token: TOKEN });
    const pending = remote.run('agent', { cwd: '/work' });
    await expect.poll(() => held.calls.length).toBe(1);
    await server.close();
    const result = await pending;
    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/sandbox/i);
  });

  it('refuses anyone without the token, and a directory outside its root', async () => {
    const held = new HeldRunner();
    const { url, remote } = await pair(held, '/work');
    const stranger = new RemoteRunner({ url, token: 'not-the-token-'.padEnd(40, 'y') });
    expect((await stranger.run('id', { cwd: '/work' })).stderr).toMatch(/401/);
    await expect(stranger.ready(100)).rejects.toThrow(/401/);
    expect((await remote.run('id', { cwd: '/etc' })).stderr).toMatch(/under \/work/);
    expect(held.calls).toEqual([]);
  });

  it('says when there is no sandbox to reach', async () => {
    const remote = new RemoteRunner({ url: 'http://127.0.0.1:1', token: TOKEN });
    await expect(remote.ready(100)).rejects.toThrow(/not usable/);
    await expect(pair(new HeldRunner(), '/work').then(({ remote: r }) => r.ready())).resolves.toBe(
      undefined
    );
  });

  it('runs a real command, with only the environment it was sent', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-sandbox-')));
    process.env.MVPFY_SANDBOX_TEST_MARKER = 'from-the-sandbox-process';
    try {
      const { remote } = await pair(new ShellRunner(), root);
      const result = await remote.run(
        'echo "$GREETING:${MVPFY_SANDBOX_TEST_MARKER:-absent}:${GH_TOKEN:-absent}" && pwd',
        { cwd: root, env: { PATH: process.env.PATH ?? '', GREETING: 'hello', GH_TOKEN: 'gho_x' } }
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual(['hello:absent:absent', root]);
    } finally {
      delete process.env.MVPFY_SANDBOX_TEST_MARKER;
    }
  });
});
