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
  const base = { MVPFY_TENANT_ID: 'acme', MVPFY_FEATURE1_URL: 'https://acme.feature1.ai' };

  it('reads a workable configuration', () => {
    const config = configFromEnv({ ...base, MVPFY_WORKER_ROOT: '/var/lib/mvpfy' });
    expect(config.tenantId).toBe('acme');
    expect(config.concurrency).toBe(1);
    expect(config.agent).toBe('claude');
  });

  it('refuses to start half-configured, rather than failing an hour in', () => {
    expect(() => configFromEnv({})).toThrow(/MVPFY_TENANT_ID/);
    expect(() => configFromEnv({ MVPFY_TENANT_ID: 'acme' })).toThrow(/MVPFY_FEATURE1_URL/);
    expect(() => configFromEnv({ ...base, MVPFY_WORKER_ROOT: 'relative' })).toThrow(/absolute/);
    expect(() => configFromEnv({ ...base, MVPFY_AGENT: 'gemini' })).toThrow(/claude or codex/);
    expect(() => configFromEnv({ ...base, MVPFY_CONCURRENCY: '0' })).toThrow(/positive/);
    expect(() => configFromEnv({ ...base, MVPFY_CONCURRENCY: 'lots' })).toThrow(/positive/);
  });

  it('refuses a concurrency nobody meant to type', () => {
    // Each execution holds checkouts, an agent and a build.
    expect(() => configFromEnv({ ...base, MVPFY_CONCURRENCY: '64' })).toThrow(/mistake/);
  });

  it('runs offline against the fake without a server URL', () => {
    const config = configFromEnv({ MVPFY_TENANT_ID: 'acme', MVPFY_FAKE_FEATURE1: '1' });
    expect(config.fake).toBe(true);
  });

  it('collects every credential that must never be printed', () => {
    const env = {
      ...base,
      MVPFY_RUNNER_TOKEN: 'runner-token-value',
      GH_TOKEN: 'gh-token-value',
      ANTHROPIC_API_KEY: 'anthropic-key-value',
    };
    const secrets = secretsIn(configFromEnv(env), env);
    expect(secrets).toContain('gh-token-value');
    expect(secrets).toContain('anthropic-key-value');
    expect(secrets).toContain('runner-token-value');
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
          repositoryId: 'repo-api',
          name: 'api',
          cloneUrl: origin,
          baseBranch: 'main',
          baseCommit,
        };
        // A local path is not an allowed clone URL in an assignment; here it
        // is handed in directly, which is the only way to test without a
        // network.
        const tree = await git.prepareWorktree('acme', 'exec-1', repo);
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
        const again = await git.prepareWorktree('acme', 'exec-1', repo);
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
