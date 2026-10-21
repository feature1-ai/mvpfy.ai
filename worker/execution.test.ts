import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { featureAssignment, standaloneStoryAssignment } from '../shared/runner/fixtures';
import { ScriptedRunner } from './exec';
import { Redactor, plainRedactor } from './redact';
import { Git, parseGitHubRepo, posixQuote } from './git';
import { Layout } from './layout';
import { PullRequests, pullRequestBody } from './prs';
import { Verifier, verificationHeld } from './verify';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-exec-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Redactor', () => {
  it('removes the credentials the worker was handed, by value', () => {
    // These match no pattern — a self-hosted token can be any string — so
    // only knowing the literal catches them.
    const r = new Redactor().remember('a-very-secret-runner-token', 'another-long-secret');
    const out = r.redact('used a-very-secret-runner-token and another-long-secret');
    expect(out).not.toContain('a-very-secret-runner-token');
    expect(out).not.toContain('another-long-secret');
  });

  it('removes credentials it has never seen, by shape', () => {
    const cases = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'AKIAIOSFODNN7EXAMPLE',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'https://user:hunter2hunter2@github.com/acme/api.git',
      'GITHUB_TOKEN=ghp_shouldnotsurvive0123456789abcd',
      'DATABASE_PASSWORD=correct-horse-battery',
    ];
    for (const text of cases) {
      const out = plainRedactor.redact(text);
      expect(out).toMatch(/redacted/);
    }
    expect(plainRedactor.redact('https://user:pw@github.com/a/b')).not.toContain('pw@');
  });

  it('leaves ordinary output alone', () => {
    const text = 'Tests: 12 passed, 0 failed in 4.2s';
    expect(plainRedactor.redact(text)).toBe(text);
  });

  it('does not redact something too short to be a secret', () => {
    // Redacting "abc" everywhere would destroy the log it is protecting.
    const r = new Redactor().remember('abc');
    expect(r.redact('abc def')).toBe('abc def');
  });

  it('bounds a summary line and strips newlines', () => {
    const r = new Redactor();
    expect(r.line('one\n\ntwo   three')).toBe('one two three');
    expect(r.line('x'.repeat(500)).length).toBe(300);
  });
});

describe('posixQuote', () => {
  it('survives the characters a branch name must never smuggle', () => {
    expect(posixQuote("a'b")).toBe("'a'\\''b'");
    expect(posixQuote('main; rm -rf /')).toBe("'main; rm -rf /'");
  });
});

describe('parseGitHubRepo', () => {
  it('reads owner and name from every form of clone URL', () => {
    expect(parseGitHubRepo('https://github.com/acme/api.git')).toEqual({
      owner: 'acme',
      name: 'api',
    });
    expect(parseGitHubRepo('git@github.com:acme/api.git')).toEqual({ owner: 'acme', name: 'api' });
    expect(parseGitHubRepo('ssh://git@github.com/acme/api')).toEqual({
      owner: 'acme',
      name: 'api',
    });
  });

  it('tells apart two repositories that share a basename', () => {
    // The whole reason the owner is read rather than the folder named.
    expect(parseGitHubRepo('https://github.com/acme/billing/api.git')?.owner).toBe('billing');
    expect(parseGitHubRepo('https://github.com/acme/orders/api.git')?.owner).toBe('orders');
  });

  it('says nothing rather than guessing', () => {
    expect(parseGitHubRepo('not a url')).toBeNull();
  });
});

describe('Git', () => {
  const repo = featureAssignment().repositories[0];

  it('never pushes to the base branch', () => {
    // The one hard rule: the worker's output is a branch and a pull request.
    const git = new Git(new ScriptedRunner(), new Layout(root));
    return expect(git.push('/tmp/x', 'main', 'main')).rejects.toThrow(/Refusing to push/);
  });

  it('pushes with a lease, so a newer attempt is not overwritten', async () => {
    const runner = new ScriptedRunner();
    const git = new Git(runner, new Layout(root));
    await git.push('/tmp/x', 'mvpfy/exec-1', 'main');
    expect(runner.calls.at(-1)?.command).toContain('--force-with-lease');
  });

  it('never lets git stop to ask for a password', async () => {
    // An unattended worker prompted for a password hangs until its lease
    // expires, which is indistinguishable from a crash.
    const runner = new ScriptedRunner();
    const git = new Git(runner, new Layout(root), { PATH: '/usr/bin' });
    await git.headCommit('/tmp/x');
    // The env is not on the recorded call, so assert via a probe runner.
    let seen: NodeJS.ProcessEnv | undefined;
    const probe = {
      async run(_c: string, o: { env?: NodeJS.ProcessEnv }) {
        seen = o.env;
        return {
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled: false,
          durationMs: 1,
        };
      },
    };
    await new Git(probe, new Layout(root)).headCommit('/tmp/x');
    expect(seen?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('clones from the commit the requirements were written against', async () => {
    const runner = new ScriptedRunner()
      // No existing branch, so the worktree is created from baseCommit.
      .when(/rev-parse --verify/, { code: 1 });
    const git = new Git(runner, new Layout(root));
    fs.mkdirSync(path.join(root, 'clones', 'acme'), { recursive: true });
    fs.mkdirSync(new Layout(root).cloneDir('acme', repo.repositoryId), { recursive: true });
    fs.writeFileSync(path.join(new Layout(root).cloneDir('acme', repo.repositoryId), 'HEAD'), '');
    await git.prepareWorktree('acme', 'exec-1', repo);
    const add = runner.calls.find((c) => c.command.includes('worktree add'));
    expect(add?.command).toContain('-b');
    expect(add?.command).toContain(repo.baseCommit);
  });

  it('continues an execution branch that already exists, rather than making another', async () => {
    const runner = new ScriptedRunner().when(/rev-parse --verify/, { code: 0 });
    const git = new Git(runner, new Layout(root));
    const clone = new Layout(root).cloneDir('acme', repo.repositoryId);
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(path.join(clone, 'HEAD'), '');
    await git.prepareWorktree('acme', 'exec-1', repo);
    const add = runner.calls.find((c) => c.command.includes('worktree add'));
    expect(add?.command).not.toContain('-b');
    expect(add?.command).toContain('mvpfy/exec-1');
  });

  it('never fetches into refs/heads, because prune would delete the work', async () => {
    // Proven against real git: the mirror refspec plus --prune removes every
    // local branch the remote does not have, which is every execution
    // branch. A resume then finds its commits gone.
    const runner = new ScriptedRunner();
    const layout = new Layout(root);
    const clone = layout.cloneDir('acme', 'repo-api');
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(path.join(clone, 'HEAD'), '');
    await new Git(runner, layout).ensureClone('acme', featureAssignment().repositories[0]);
    const fetch = runner.calls.find((c) => c.command.includes('fetch'));
    expect(fetch?.command).toContain('refs/remotes/origin/*');
    expect(fetch?.command).not.toContain(':refs/heads/*');
  });

  it('reads commits as records, ignoring anything malformed', async () => {
    const runner = new ScriptedRunner().when(/git log/, {
      stdout: `abc1234\u001fFirst thing\u001e\u001edef5678\u001fSecond thing\u001e`,
    });
    const commits = await new Git(runner, new Layout(root)).commitsSince('/tmp/x', 'a'.repeat(40));
    expect(commits).toEqual([
      { sha: 'abc1234', subject: 'First thing' },
      { sha: 'def5678', subject: 'Second thing' },
    ]);
  });

  it('commits by path rather than sweeping the checkout', async () => {
    // `git add -A` takes whatever the agent dropped, including a .env it
    // wrote while debugging.
    const runner = new ScriptedRunner().when(/diff --cached/, { stdout: 'src/a.ts\n' });
    const git = new Git(runner, new Layout(root));
    await git.commit('/tmp/x', 'US-01: thing', ['src/a.ts']);
    const add = runner.calls.find((c) => c.command.startsWith('git add'));
    expect(add?.command).toContain("'src/a.ts'");
    expect(add?.command).not.toContain('-A');
  });

  it('commits nothing when nothing was staged', async () => {
    const runner = new ScriptedRunner().when(/diff --cached/, { stdout: '  \n' });
    const git = new Git(runner, new Layout(root));
    expect(await git.commit('/tmp/x', 'msg', ['src/a.ts'])).toBeNull();
    expect(runner.calls.some((c) => c.command.includes('commit --no-verify'))).toBe(false);
  });
});

describe('Verifier', () => {
  const worktrees = { 'repo-api': '/w/api', 'repo-web': '/w/web' };

  it('reports a failing check as failed, with its exit code', async () => {
    const runner = new ScriptedRunner().when(/npm test/, { code: 1, stderr: '2 failing' });
    const v = new Verifier(runner, plainRedactor);
    const results = await v.verifyRepository(featureAssignment(), 'repo-api', { worktrees });
    expect(results[0].outcome).toBe('failed');
    expect(results[0].exitCode).toBe(1);
    expect(results[0].summary).toContain('2 failing');
  });

  it('never counts a check that could not run as a pass', async () => {
    // 127 is the shell saying the command is not there. Calling that a
    // failing test sends somebody looking for a bug in the code.
    const runner = new ScriptedRunner().when(/npm test/, { code: 127, stderr: 'npm: not found' });
    const results = await new Verifier(runner, plainRedactor).verifyRepository(
      featureAssignment(),
      'repo-api',
      { worktrees }
    );
    expect(results[0].outcome).toBe('unavailable');
    expect(results[0].reason).toMatch(/not found/);
  });

  it('reports a timeout as unavailable and says how long it waited', async () => {
    const runner = new ScriptedRunner().when(/npm test/, { timedOut: true, code: null });
    const results = await new Verifier(runner, plainRedactor).verifyRepository(
      featureAssignment(),
      'repo-api',
      { worktrees }
    );
    expect(results[0].outcome).toBe('unavailable');
    expect(results[0].reason).toMatch(/longer than/);
  });

  it('says out loud when nothing was verified', async () => {
    // An empty list reads as "nothing failed". It is not the same claim.
    const assignment = featureAssignment({ verification: { steps: [] } });
    const results = await new Verifier(new ScriptedRunner(), plainRedactor).verifyRepository(
      assignment,
      'repo-api',
      { worktrees }
    );
    expect(results[0].outcome).toBe('unavailable');
    expect(results[0].summary).toBe('Nothing was verified');
  });

  it('marks a discovered command as discovered', async () => {
    const dir = path.join(root, 'api');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    const results = await new Verifier(new ScriptedRunner(), plainRedactor).verifyRepository(
      standaloneStoryAssignment(),
      'repo-api',
      { worktrees: { 'repo-api': dir } }
    );
    expect(results[0].discovered).toBe(true);
    expect(results[0].outcome).toBe('passed');
  });

  it('reports no checkout rather than pretending to run', async () => {
    const results = await new Verifier(new ScriptedRunner(), plainRedactor).verifyRepository(
      featureAssignment(),
      'repo-api',
      { worktrees: {} }
    );
    expect(results[0].outcome).toBe('unavailable');
    expect(results[0].reason).toMatch(/No checkout/);
  });

  it('redacts a secret an agent printed into its test output', async () => {
    const runner = new ScriptedRunner().when(/npm test/, {
      code: 1,
      stderr: 'failed to auth with ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const results = await new Verifier(runner, new Redactor()).verifyRepository(
      featureAssignment(),
      'repo-api',
      { worktrees }
    );
    expect(results[0].summary).not.toContain('ghp_');
  });
});

describe('verificationHeld', () => {
  const steps = featureAssignment().verification.steps;
  const result = (stepId: string, outcome: string) =>
    ({ stepId, outcome }) as unknown as Parameters<typeof verificationHeld>[0][number];

  it('holds only when everything required passed', () => {
    expect(verificationHeld([result('v-api-test', 'passed')], steps)).toBe(true);
    expect(verificationHeld([result('v-api-test', 'failed')], steps)).toBe(false);
  });

  it('does not let an unavailable check stand in for a pass', () => {
    expect(verificationHeld([result('v-api-test', 'unavailable')], steps)).toBe(false);
  });

  it('lets an optional check fail', () => {
    const optional = [{ ...steps[0], id: 'v-lint', optional: true }];
    expect(verificationHeld([result('v-lint', 'failed')], optional)).toBe(true);
  });
});

describe('PullRequests', () => {
  const target = {
    worktree: '/w/api',
    owner: 'acme',
    name: 'api',
    headBranch: 'mvpfy/exec-1',
    baseBranch: 'main',
    title: 'FEA-142',
    body: 'body',
  };
  const listing = (headRefName: string) =>
    JSON.stringify([
      { number: 7, url: 'https://github.com/acme/api/pull/7', headRefName, baseRefName: 'main' },
    ]);

  it('reuses the pull request already open for the branch', async () => {
    // The retry case: a crash after creating must not create a second.
    const runner = new ScriptedRunner().when(/pr list/, { stdout: listing('mvpfy/exec-1') });
    const pr = await new PullRequests(runner, plainRedactor).ensure({ ...target, worktree: root });
    expect(pr.number).toBe(7);
    expect(pr.createdByThisAttempt).toBe(false);
    expect(runner.calls.some((c) => c.command.includes('pr create'))).toBe(false);
  });

  it('asks GitHub by head branch, never by a URL from a log', async () => {
    const runner = new ScriptedRunner().when(/pr list/, { stdout: '[]' });
    await new PullRequests(runner, plainRedactor).findExisting(target);
    const list = runner.calls.find((c) => c.command.includes('pr list'));
    expect(list?.command).toContain("--head 'mvpfy/exec-1'");
    expect(list?.command).toContain('--state all');
  });

  it('ignores a pull request whose head is a different branch', async () => {
    // A wrong pull request attached to an artifact is worse than none.
    const runner = new ScriptedRunner().when(/pr list/, { stdout: listing('somebody-else') });
    expect(await new PullRequests(runner, plainRedactor).findExisting(target)).toBeNull();
  });

  it('creates one when there is none, and reads it back', async () => {
    const runner = new ScriptedRunner()
      .when(/pr list/, { stdout: listing('mvpfy/exec-1') })
      .when(/pr list/, { stdout: '[]' }, 1);
    const pr = await new PullRequests(runner, plainRedactor).ensure({ ...target, worktree: root });
    expect(pr.createdByThisAttempt).toBe(true);
    expect(runner.calls.filter((c) => c.command.includes('pr create'))).toHaveLength(1);
  });

  it('treats a create that lost its race as success, not an error', async () => {
    // Another attempt opened one between the look and the create.
    const runner = new ScriptedRunner()
      .when(/pr list/, { stdout: listing('mvpfy/exec-1') })
      .when(/pr list/, { stdout: '[]' }, 1)
      .when(/pr create/, { code: 1, stderr: 'a pull request already exists' });
    const pr = await new PullRequests(runner, plainRedactor).ensure({ ...target, worktree: root });
    expect(pr.number).toBe(7);
    expect(pr.createdByThisAttempt).toBe(false);
  });

  it('fails loudly when there is still no pull request afterwards', async () => {
    const runner = new ScriptedRunner()
      .when(/pr list/, { stdout: '[]' })
      .when(/pr create/, { code: 1, stderr: 'permission denied' });
    await expect(
      new PullRequests(runner, plainRedactor).ensure({ ...target, worktree: root })
    ).rejects.toThrow(/Could not open a pull request/);
  });

  it('redacts the body before it is published', async () => {
    const runner = new ScriptedRunner()
      .when(/pr list/, { stdout: listing('mvpfy/exec-1') })
      .when(/pr list/, { stdout: '[]' }, 1);
    let written = '';
    const prs = new PullRequests(
      {
        async run(command: string, o: { cwd: string }) {
          if (command.includes('pr create')) {
            written = fs.readFileSync(path.join(o.cwd, '.mvpfy-pr-body.md'), 'utf8');
          }
          return runner.run(command, o as never);
        },
      },
      new Redactor()
    );
    await prs.ensure({
      ...target,
      worktree: root,
      body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    expect(written).not.toContain('ghp_');
    expect(fs.existsSync(path.join(root, '.mvpfy-pr-body.md'))).toBe(false);
  });
});

describe('pullRequestBody', () => {
  it('shows what was checked and what was not', () => {
    const body = pullRequestBody({
      artifactCode: 'FEA-142',
      artifactTitle: 'Paged product list',
      executionId: 'exec-1',
      requirementsRevision: 'rev-3',
      acceptanceCriteria: [{ id: 'ac-1', text: 'A buyer can reach every product' }],
      verification: [
        { name: 'API tests', outcome: 'passed' },
        { name: 'Web tests', outcome: 'unavailable', reason: 'no test script' },
      ],
    });
    expect(body).toContain('A buyer can reach every product');
    expect(body).toContain('| Web tests | unavailable | no test script |');
    expect(body).toContain('exec-1');
    // A reviewer must not read this as something that was merged or signed off.
    expect(body).toMatch(/Nothing here has been merged or marked done/);
  });

  it('says so when nothing was verified', () => {
    const body = pullRequestBody({
      artifactTitle: 'Thing',
      executionId: 'e',
      requirementsRevision: 'r',
      acceptanceCriteria: [],
      verification: [],
    });
    expect(body).toContain('nothing was verified');
  });
});
