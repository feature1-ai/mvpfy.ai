import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { TerminalIo } from './setupIo';
import { ensureSignInFolders } from './signInFolders';
import { commandFrom, configFromEnv, workerNameFrom } from './config';
import { ghLoginToken } from './credentials';
import { agentEnv, checkEnv } from './childEnv';
import { SavedConnection } from './feature1Connection';
import { Feature1Login, Feature1LoginError, workspaceBaseUrl } from './feature1Login';
import { RunnerCredentialStore, SavedRunner, isExpired, timeLeft } from './runnerCredential';
import {
  SetupCommands,
  SetupIo,
  SetupStep,
  agentStep,
  feature1Step,
  githubStep,
  runSetup,
} from './setup';

const TOKEN = 'a'.repeat(64);
const NOW = new Date('2026-11-24T10:00:00Z');
const inHours = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

function io(answers: string[] = []): SetupIo & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    say: (text) => void said.push(text),
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
  };
}

/** Commands whose probe starts failing and passes once the sign-in has run. */
function commands(options: { signsIn?: boolean; loginCode?: number; stdout?: string } = {}) {
  const ran: string[] = [];
  let signedIn = false;
  const fake: SetupCommands & { ran: string[] } = {
    ran,
    probe: async (command) => {
      ran.push(`probe: ${command}`);
      return { code: signedIn ? 0 : 1, stdout: signedIn ? (options.stdout ?? '') : '' };
    },
    interactive: async (command) => {
      ran.push(`run: ${command}`);
      const code = options.loginCode ?? 0;
      if (code === 0 && options.signsIn !== false) signedIn = true;
      return code;
    },
  };
  return fake;
}

const step = (id: string, states: boolean[], perform: () => Promise<void> = async () => {}) => {
  let performed = 0;
  const made: SetupStep & { performed(): number } = {
    id,
    title: id,
    done: async () => states.shift() ?? false,
    perform: async () => {
      performed += 1;
      await perform();
    },
    performed: () => performed,
  };
  return made;
};

describe('runSetup', () => {
  it('leaves alone what is already in place', async () => {
    const a = step('a', [true]);
    const out = io();
    expect(await runSetup([a], out)).toEqual({ ok: true, failed: [] });
    expect(a.performed()).toBe(0);
    expect(out.said.join('\n')).toContain('Already in place');
  });

  it('believes the check afterwards, not the command', async () => {
    // The sign-in returned without complaint and nobody is signed in.
    const a = step('a', [false, false]);
    const out = io();
    expect(await runSetup([a], out)).toEqual({ ok: false, failed: ['a'] });
    expect(out.said.join('\n')).toContain('still not in place');
  });

  it('carries on to the next step when one fails, and names what is left', async () => {
    const a = step('a', [false], async () => {
      throw new Error('the code expired');
    });
    const b = step('b', [false, true]);
    const out = io();
    expect(await runSetup([a, b], out)).toEqual({ ok: false, failed: ['a'] });
    expect(b.performed()).toBe(1);
    expect(out.said.join('\n')).toContain('the code expired');
    expect(out.said.at(-1)).toContain('Not finished: a');
  });
});

describe('the GitHub step', () => {
  it("signs in with gh's browser flow, and does not make gh every git's helper", async () => {
    const fake = commands();
    expect(await runSetup([githubStep(fake)], io())).toMatchObject({ ok: true });
    const login = fake.ran.find((line) => line.startsWith('run:')) ?? '';
    expect(login).toContain('gh auth login --hostname github.com --git-protocol https --web');
    expect(login).not.toContain('setup-git');
  });

  it('fails when the sign-in is abandoned', async () => {
    expect(await runSetup([githubStep(commands({ loginCode: 1 }))], io())).toMatchObject({
      failed: ['github'],
    });
  });
});

describe('the agent step', () => {
  it('uses the device sign-in for Codex, which needs no browser on the runner', async () => {
    const fake = commands();
    await runSetup([agentStep('codex', fake, {})], io());
    expect(fake.ran).toContain('run: codex login --device-auth');
  });

  it('reads what Claude says rather than how it exits', async () => {
    // `claude auth status` exits zero signed out.
    const signedOut = commands({ stdout: '{"loggedIn": false}' });
    expect(await runSetup([agentStep('claude', signedOut, {})], io())).toMatchObject({
      failed: ['claude'],
    });
    const signedIn = commands({ stdout: '{"loggedIn": true}' });
    expect(await runSetup([agentStep('claude', signedIn, {})], io())).toMatchObject({ ok: true });
  });

  it('asks for nothing when a key is already in the environment', async () => {
    const fake = commands();
    await runSetup([agentStep('claude', fake, { ANTHROPIC_API_KEY: 'sk-test' })], io());
    expect(fake.ran).toEqual([]);
  });
});

describe('the Feature1 step', () => {
  const CONNECTION: SavedConnection = {
    feature1BaseUrl: 'https://a.test',
    token: 'saved-personal-token',
    tenant: { id: 't1', slug: 'acme' },
    user: { id: 'u1' },
  };

  function fixture(saved: SavedRunner | null = null, connection: SavedConnection | null = null) {
    const calls: string[] = [];
    const state = { saved, connection };
    const deps = {
      login: {
        verify: async (baseUrl: string, token: string) => {
          calls.push(`verify ${baseUrl} ${token}`);
          return { tenant: { id: 't1', slug: 'acme' }, user: { id: 'u1', email: 'pm@acme.test' } };
        },
        mintRunner: async (baseUrl: string, _token: string, name: string) => {
          calls.push(`mint ${baseUrl} ${name}`);
          return { token: TOKEN, expiresAt: inHours(24) };
        },
      },
      store: {
        load: () => state.saved,
        save: (next: SavedRunner) => void (state.saved = next),
      },
      connections: {
        load: () => state.connection,
        save: (next: SavedConnection) => void (state.connection = next),
      },
      name: 'runner-1',
      env: {},
      now: () => NOW,
    };
    return { calls, state, deps };
  }

  it('checks the token against the workspace, keeps the sign-in, and adds a runner', async () => {
    const { calls, state, deps } = fixture();
    const out = io(['acme.feature1.ai', 'personal-token']);
    expect(await runSetup([feature1Step({ ...deps, io: out })], out)).toMatchObject({ ok: true });
    expect(calls).toEqual([
      'verify https://acme.feature1.ai personal-token',
      'mint https://acme.feature1.ai runner-1',
    ]);
    expect(state.connection).toEqual({
      feature1BaseUrl: 'https://acme.feature1.ai',
      token: 'personal-token',
      tenant: { id: 't1', slug: 'acme' },
      user: { id: 'u1', email: 'pm@acme.test' },
    });
    expect(state.saved).toEqual({
      feature1BaseUrl: 'https://acme.feature1.ai',
      token: TOKEN,
      expiresAt: inHours(24),
      name: 'runner-1',
    });
    // Kept, but never shown.
    expect(out.said.join('\n')).not.toContain('personal-token');
  });

  it('can be scripted from the environment, asking nothing', async () => {
    const { deps } = fixture();
    const out = io();
    const env = { MVPFY_FEATURE1_URL: 'https://acme.feature1.ai', MVPFY_FEATURE1_TOKEN: 'tok' };
    expect(await runSetup([feature1Step({ ...deps, env, io: out })], out)).toMatchObject({
      ok: true,
    });
    expect(out.asked).toEqual([]);
  });

  it('is signed in, and can pull, where Feature1 hands out no work', async () => {
    const { state, deps } = fixture();
    deps.login.mintRunner = async () => {
      throw new Feature1LoginError('Only an organisation admin can add a runner.');
    };
    const out = io(['acme.feature1.ai', 'tok']);
    expect(await runSetup([feature1Step({ ...deps, io: out })], out)).toMatchObject({ ok: true });
    expect(state.connection?.token).toBe('tok');
    expect(state.saved).toBeNull();
    expect(out.said.join('\n')).toContain('organisation admin');
    expect(out.said.join('\n')).toContain('implement <feature code>');
    // And is left alone next time: no runner credential is not unfinished.
    const again = io();
    await runSetup([feature1Step({ ...deps, io: again })], again);
    expect(again.said.join('\n')).toContain('Already in place');
  });

  it('stops, having saved nothing, when Feature1 rejects the token', async () => {
    const { state, deps } = fixture();
    deps.login.verify = async () => {
      throw new Feature1LoginError('Feature1 rejected that token.');
    };
    const out = io(['acme.feature1.ai', 'tok']);
    expect(await runSetup([feature1Step({ ...deps, io: out })], out)).toMatchObject({
      failed: ['feature1'],
    });
    expect(state.connection).toBeNull();
    expect(state.saved).toBeNull();
  });

  it('leaves a credential with hours left alone', async () => {
    const fresh = fixture(
      { feature1BaseUrl: 'https://a.test', token: TOKEN, expiresAt: inHours(20), name: 'r' },
      CONNECTION
    );
    await runSetup([feature1Step({ ...fresh.deps, io: io() })], io());
    expect(fresh.calls).toEqual([]);
  });

  it('renews one about to lapse with the saved sign-in, asking nothing', async () => {
    const lapsing = fixture(
      { feature1BaseUrl: 'https://a.test', token: TOKEN, expiresAt: inHours(0.5), name: 'r' },
      CONNECTION
    );
    const out = io();
    expect(await runSetup([feature1Step({ ...lapsing.deps, io: out })], out)).toMatchObject({
      ok: true,
    });
    expect(lapsing.calls).toEqual([
      'verify https://a.test saved-personal-token',
      'mint https://a.test runner-1',
    ]);
    expect(out.asked).toEqual([]);
    expect(lapsing.state.saved?.expiresAt).toBe(inHours(24));
  });

  it('asks again when the saved sign-in is no longer accepted', async () => {
    const stale = fixture(
      { feature1BaseUrl: 'https://a.test', token: TOKEN, expiresAt: inHours(0.5), name: 'r' },
      CONNECTION
    );
    const verify = stale.deps.login.verify;
    stale.deps.login.verify = async (baseUrl, token) => {
      if (token === CONNECTION.token) throw new Feature1LoginError('rejected');
      return verify(baseUrl, token);
    };
    // Enter accepts the workspace it was set up with last time.
    const out = io(['', 'new-token']);
    expect(await runSetup([feature1Step({ ...stale.deps, io: out })], out)).toMatchObject({
      ok: true,
    });
    expect(stale.state.connection?.token).toBe('new-token');
    expect(stale.state.connection?.feature1BaseUrl).toBe('https://a.test');
  });
});

describe('Feature1Login', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('refuses to send a token anywhere but https, this machine excepted', () => {
    expect(workspaceBaseUrl('acme.feature1.ai/settings')).toBe('https://acme.feature1.ai');
    expect(workspaceBaseUrl('http://localhost:3001')).toBe('http://localhost:3001');
    expect(() => workspaceBaseUrl('http://acme.feature1.ai')).toThrow(/https/);
    expect(() => workspaceBaseUrl('https://me:pw@acme.feature1.ai')).toThrow(/user name/);
  });

  it('says a rejected token is rejected', async () => {
    await expect(new Feature1Login(answer(401, {})).verify('https://a.test', 't')).rejects.toThrow(
      /rejected that token/
    );
  });

  it('tells apart "not an admin" from "not turned on"', async () => {
    const mint = (status: number) =>
      new Feature1Login(answer(status, { success: false })).mintRunner('https://a.test', 't', 'r');
    await expect(mint(403)).rejects.toThrow(/organisation admin/);
    await expect(mint(404)).rejects.toThrow(/turned on/);
  });

  it('accepts only a credential of the shape the worker can present', async () => {
    const good = { credential: { id: 'c', token: TOKEN, expires_at: inHours(24) } };
    expect(
      await new Feature1Login(answer(200, good)).mintRunner('https://a.test', 't', 'r')
    ).toEqual({ token: TOKEN, expiresAt: inHours(24) });
    const bad = { credential: { token: 'short', expires_at: inHours(24) } };
    await expect(
      new Feature1Login(answer(200, bad)).mintRunner('https://a.test', 't', 'r')
    ).rejects.toThrow(/does not know/);
  });
});

describe('the saved runner credential', () => {
  const saved: SavedRunner = {
    feature1BaseUrl: 'https://acme.feature1.ai',
    token: TOKEN,
    expiresAt: inHours(24),
    name: 'runner-1',
  };

  it('is read back as it was written, leaving no temporary file behind', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-runner-'));
    const store = new RunnerCredentialStore(root);
    expect(store.load()).toBeNull();
    store.save(saved);
    expect(store.load()).toEqual(saved);
    expect(fs.readdirSync(root)).toEqual(['runner.json']);
  });

  // The worker runs on Linux and macOS and says so (index.ts). Windows keeps
  // only a read-only bit, so it reports 0o666 however the file was made.
  it.runIf(process.platform !== 'win32')('is written for this user only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-runner-'));
    const store = new RunnerCredentialStore(root);
    store.save(saved);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('is nothing at all when the file is damaged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-runner-'));
    const store = new RunnerCredentialStore(root);
    fs.writeFileSync(store.file, '{"token":"nope"}');
    expect(store.load()).toBeNull();
  });

  it('knows when it has lapsed and how long it has left', () => {
    expect(isExpired(saved, NOW)).toBe(false);
    expect(isExpired({ expiresAt: inHours(-1) }, NOW)).toBe(true);
    expect(timeLeft(saved, NOW)).toBe('24 hours');
    expect(timeLeft({ expiresAt: inHours(0.5) }, NOW)).toBe('30 minutes');
  });

  it('starts the worker with no variables set', () => {
    const config = configFromEnv({}, saved, NOW);
    expect(config.feature1BaseUrl).toBe('https://acme.feature1.ai');
    expect(config.runnerToken).toBe(TOKEN);
  });

  it('gives way to what the operator set', () => {
    const other = 'b'.repeat(64);
    const env = { MVPFY_FEATURE1_URL: 'https://other.test', MVPFY_RUNNER_TOKEN: other };
    expect(configFromEnv(env, saved, NOW)).toMatchObject({
      feature1BaseUrl: 'https://other.test',
      runnerToken: other,
    });
  });

  it('refuses to start on a lapsed credential, and says what to do', () => {
    expect(() => configFromEnv({}, { ...saved, expiresAt: inHours(-1) }, NOW)).toThrow(
      /expired.*setup/s
    );
    expect(() => configFromEnv({}, null, NOW)).toThrow(/has not been set up/);
  });
});

describe('the GitHub login setup made', () => {
  it('is read from gh for the worker', async () => {
    expect(await ghLoginToken(async () => ({ code: 0, stdout: 'gho_abcdefgh12345\n' }))).toBe(
      'gho_abcdefgh12345'
    );
    expect(await ghLoginToken(async () => ({ code: 1, stdout: '' }))).toBeNull();
    expect(await ghLoginToken(async () => ({ code: 0, stdout: 'two words\n' }))).toBeNull();
  });

  it('is not where the agent can find it by asking gh', () => {
    const env = agentEnv({ GH_CONFIG_DIR: '/var/lib/mvpfy/auth/gh', PATH: '/usr/bin' });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('the folders the sign-ins live in', () => {
  const pointers = {
    CLAUDE_CONFIG_DIR: '/var/lib/mvpfy/auth/claude',
    CODEX_HOME: '/var/lib/mvpfy/auth/codex',
    PATH: '/usr/bin',
  };

  it('are told to the agent, which signs in with them', () => {
    expect(agentEnv(pointers)).toEqual(pointers);
  });

  it("are not told to a repository's own checks, which never need them", () => {
    // checkEnv runs `npm test` and whatever a postinstall hook reaches.
    expect(checkEnv(pointers)).toEqual({ PATH: '/usr/bin' });
  });
});

describe('what the arguments ask for', () => {
  it('claims work with none, and signs in with setup', () => {
    expect(commandFrom(['node', 'index.js'])).toEqual({ name: 'run' });
    expect(commandFrom(['node', 'index.js', 'setup'])).toEqual({ name: 'setup' });
  });

  it('refuses anything else rather than quietly starting to claim work', () => {
    // `setup --renew` once started a second worker on the same volume.
    expect(() => commandFrom(['node', 'index.js', 'setup', '--renew'])).toThrow(/Unrecognised/);
    expect(() => commandFrom(['node', 'index.js', 'setuo'])).toThrow(/Unrecognised/);
  });
});

describe('what this worker calls itself', () => {
  it('is what the operator named it', () => {
    expect(workerNameFrom({ MVPFY_WORKER_NAME: 'eu-runner-3' })).toBe('eu-runner-3');
  });

  it('otherwise says which machine it is, so an admin can tell runners apart', () => {
    // The name Feature1 registers the runner under; a fixed string gave every
    // runner in a workspace the same one.
    const name = workerNameFrom({});
    expect(name).toMatch(/^mvpfy worker/);
    if (os.hostname() && os.hostname() !== 'localhost') {
      expect(name).toBe(`mvpfy worker ${os.hostname()}`);
    }
  });
});

describe('the terminal setup talks through', () => {
  const streams = () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    let written = '';
    output.on('data', (chunk: Buffer) => (written += chunk.toString('utf8')));
    return { input, output, written: () => written };
  };

  it('hands back what was typed', async () => {
    const { input, output } = streams();
    const answer = new TerminalIo(input, output).ask('Address: ');
    input.write('https://acme.feature1.ai\n');
    expect(await answer).toBe('https://acme.feature1.ai');
  });

  it('takes input that ends without an answer as no answer, rather than waiting forever', async () => {
    const { input, output } = streams();
    const answer = new TerminalIo(input, output).ask('Address: ');
    input.end();
    expect(await answer).toBe('');
  });

  it('does not show a secret as it is typed', async () => {
    const { input, output, written } = streams();
    const answer = new TerminalIo(input, output).ask('Personal token: ', { secret: true });
    input.write('f1_secret_value\n');
    expect(await answer).toBe('f1_secret_value');
    expect(written()).toContain('Personal token: ');
    expect(written()).not.toContain('f1_secret_value');
  });
});

describe('the folders sign-ins are kept in', () => {
  it('are made before anything looks there', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-signin-'));
    const codex = path.join(root, 'auth', 'codex');
    const gh = path.join(root, 'auth', 'gh');
    expect(ensureSignInFolders({ CODEX_HOME: codex, GH_CONFIG_DIR: gh })).toEqual([gh, codex]);
    expect(fs.statSync(codex).isDirectory()).toBe(true);
    // Again, with them there already, is not an error.
    expect(() => ensureSignInFolders({ CODEX_HOME: codex })).not.toThrow();
  });

  // POSIX only, as above: Windows ignores a directory's mode and reports 0o777.
  it.runIf(process.platform !== 'win32')('are private to this user', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-signin-'));
    const codex = path.join(root, 'auth', 'codex');
    ensureSignInFolders({ CODEX_HOME: codex });
    expect(fs.statSync(codex).mode & 0o777).toBe(0o700);
  });

  it('leaves a tool to its own default when nothing points it elsewhere', () => {
    expect(ensureSignInFolders({})).toEqual([]);
    expect(ensureSignInFolders({ CODEX_HOME: 'relative/path' })).toEqual([]);
  });
});
