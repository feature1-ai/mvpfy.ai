import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Git } from './git';
import { Layout } from './layout';
import { ShellRunner } from './exec';
import { plainRedactor } from './redact';
import { configFromEnv, secretsIn } from './config';

/**
 * The claims that are easy to make and easy to break: that the worker is
 * headless, and that its git layer works against real git rather than only
 * against a fake.
 */

describe('the worker runs without Electron', () => {
  const files = fs
    .readdirSync(path.join(__dirname))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('imports nothing from electron, react or the desktop services', () => {
    // The whole point of a worker entry point. A single import of
    // `electron` makes the Docker image need a display server.
    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source, `${file} imports electron`).not.toMatch(/from ['"]electron['"]/);
      expect(source, `${file} imports react`).not.toMatch(/from ['"]react/);
      expect(source, `${file} reaches into the desktop app`).not.toMatch(
        /from ['"]\.\.\/(electron|src)\//
      );
    }
  });

  it('shares the agent command assembly rather than copying it', () => {
    // Extracted to shared/ so the two cannot drift.
    const source = fs.readFileSync(path.join(__dirname, 'agentRun.ts'), 'utf8');
    expect(source).toMatch(/from '\.\.\/shared\/agentCommands'/);
  });
});

describe('configFromEnv', () => {
  const base = {
    MVPFY_FEATURE1_URL: 'https://acme.feature1.ai',
    MVPFY_RUNNER_TOKEN: 'a'.repeat(64),
  };

  it('reads a workable configuration', () => {
    const config = configFromEnv({ ...base, MVPFY_WORKER_ROOT: '/var/lib/mvpfy' });
    expect(config.runnerToken).toBe('a'.repeat(64));
    expect(config.agent).toBe('claude');
    // Comfortably inside the three-minute lease.
    expect(config.heartbeatIntervalMs).toBeLessThan(120_000);
  });

  it('refuses to start half-configured, rather than failing an hour in', () => {
    expect(() => configFromEnv({})).toThrow(/MVPFY_FEATURE1_URL/);
    expect(() => configFromEnv({ ...base, MVPFY_WORKER_ROOT: 'relative' })).toThrow(/absolute/);
    expect(() => configFromEnv({ ...base, MVPFY_AGENT: 'gemini' })).toThrow(/claude or codex/);
  });

  it('refuses a credential that is not the shape Feature1 mints', () => {
    // 64 hex characters, valid for 24 hours. Anything else is a 401 that
    // looks exactly like an outage.
    expect(() => configFromEnv({ ...base, MVPFY_RUNNER_TOKEN: 'not-a-credential' })).toThrow(
      /64-character runner credential/
    );
    expect(() => configFromEnv({ MVPFY_FEATURE1_URL: base.MVPFY_FEATURE1_URL })).toThrow(
      /runner credential/
    );
  });

  it('refuses a heartbeat slower than the lease it has to keep alive', () => {
    // The lease is three minutes; a slower heartbeat loses every long
    // execution to a reclaim, which looks like random failure.
    expect(() => configFromEnv({ ...base, MVPFY_HEARTBEAT_INTERVAL_MS: '300000' })).toThrow(
      /three-minute lease/
    );
  });

  it('runs offline against the fake with no server and no credential', () => {
    expect(configFromEnv({ MVPFY_FAKE_FEATURE1: '1' }).fake).toBe(true);
  });

  it('collects every credential that must never be printed', () => {
    const env = {
      ...base,
      GH_TOKEN: 'gh-token-value',
      ANTHROPIC_API_KEY: 'anthropic-key-value',
    };
    const secrets = secretsIn(configFromEnv(env), env);
    expect(secrets).toContain('gh-token-value');
    expect(secrets).toContain('anthropic-key-value');
    expect(secrets).toContain('a'.repeat(64));
  });
});

/**
 * Against real git. Slower than the rest, and worth it: every other test
 * uses a fake git, so without this nothing proves the commands are even
 * valid.
 */
describe('Git, against real git', () => {
  const gitAvailable = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(gitAvailable)(
    'clones, makes a worktree at the base commit, and commits what changed',
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-realgit-'));
      try {
        // A remote to clone from.
        const origin = path.join(tmp, 'origin');
        fs.mkdirSync(origin);
        const run = (args: string[], cwd: string) =>
          execFileSync('git', args, {
            cwd,
            stdio: 'pipe',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
          })
            .toString()
            .trim();
        run(['init', '-q', '-b', 'main'], origin);
        run(['config', 'user.email', 't@example.com'], origin);
        run(['config', 'user.name', 'Test'], origin);
        fs.writeFileSync(path.join(origin, 'README.md'), '# origin\n');
        run(['add', '.'], origin);
        run(['commit', '-q', '-m', 'first'], origin);
        const baseCommit = run(['rev-parse', 'HEAD'], origin);

        const layout = new Layout(path.join(tmp, 'worker'));
        const git = new Git(new ShellRunner(plainRedactor), layout);
        const repo = {
          id: '11111111-1111-1111-1111-111111111111',
          name: 'api',
          url: origin,
          base_branch: 'main',
        };
        // A local path is not an allowed clone URL in an assignment; here it
        // is handed in directly, which is the only way to test without a
        // network.
        const tenant = '22222222-2222-2222-2222-222222222222';
        const execution = '33333333-3333-3333-3333-333333333333';
        const tree = await git.prepareWorktree(tenant, execution, repo);
        // Feature1 sends a branch; the worker resolves and reports the sha.
        expect(await git.baseCommit(tenant, repo)).toBe(baseCommit);
        expect(fs.existsSync(path.join(tree, 'README.md'))).toBe(true);
        expect(await git.headCommit(tree)).toBe(baseCommit);

        fs.writeFileSync(path.join(tree, 'added.txt'), 'new file\n');
        const changed = await git.changedPaths(tree);
        expect(changed).toContain('added.txt');

        const sha = await git.commit(tree, 'US-01: add a file', changed);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        const commits = await git.commitsSince(tree, baseCommit);
        expect(commits.map((c) => c.subject)).toEqual(['US-01: add a file']);

        // Resuming finds the branch rather than making a second one.
        const again = await git.prepareWorktree(tenant, execution, repo);
        expect(again).toBe(tree);
        expect(await git.hasUncommittedChanges(tree)).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.runIf(gitAvailable)('refuses to push to the base branch', async () => {
    const layout = new Layout(path.join(os.tmpdir(), 'mvpfy-nopush'));
    const git = new Git(new ShellRunner(plainRedactor), layout);
    await expect(git.push('/tmp', 'main', 'main')).rejects.toThrow(/Refusing to push/);
  });
});
