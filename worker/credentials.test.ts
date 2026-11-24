import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IDS, featureExecution } from '../shared/runner/fixtures';
import {
  ExecutionCredentialSession,
  GIT_PASSWORD_ENV,
  ghTokenEnv,
  gitTokenEnv,
  httpsHosts,
  operatorGithubToken,
} from './credentials';
import { ScriptedRunner } from './exec';
import { Git } from './git';
import { Layout } from './layout';
import { PullRequests } from './prs';
import { plainRedactor } from './redact';

const TOKEN = 'ghs_issued_for_this_execution';
const MCP = { url: 'https://acme-mcp.feature1.ai/mcp/', token: 'f1r_read_only_for_this_run' };
const base = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

const withCredentials = () =>
  featureExecution({ credentials: { github: { token: TOKEN }, feature1_mcp: MCP } });

describe('httpsHosts', () => {
  it('names the hosts an execution’s repositories live on, once each', () => {
    expect(httpsHosts(featureExecution())).toEqual(['github.com']);
  });

  it('offers nothing to an ssh remote, which takes no token', () => {
    const execution = featureExecution();
    execution.repositories = [{ ...execution.repositories[0], url: 'git@github.com:acme/api.git' }];
    expect(httpsHosts(execution)).toEqual([]);
  });
});

describe('the session', () => {
  it('authorises nothing until an execution begins, and nothing after it ends', () => {
    const session = new ExecutionCredentialSession('ghp_operator');
    expect(session.git.apply(base)).toEqual(base);
    session.begin(withCredentials());
    expect(session.git.apply(base)[GIT_PASSWORD_ENV]).toBe(TOKEN);
    session.end();
    expect(session.git.apply(base)).toEqual(base);
    expect(session.gh.apply(base)).toEqual(base);
    expect(session.agentMcp()).toBeNull();
  });

  it('returns every secret it took, so the caller can keep them out of logs', () => {
    const session = new ExecutionCredentialSession();
    expect(session.begin(withCredentials()).sort()).toEqual([TOKEN, MCP.token].sort());
  });

  it('prefers the token the claim issued over the operator’s own', () => {
    const session = new ExecutionCredentialSession('ghp_operator');
    session.begin(withCredentials());
    expect(session.gh.apply(base).GH_TOKEN).toBe(TOKEN);
  });

  it('falls back to the operator’s token when Feature1 issues none', () => {
    const session = new ExecutionCredentialSession('ghp_operator');
    session.begin(featureExecution());
    expect(session.git.apply(base)[GIT_PASSWORD_ENV]).toBe('ghp_operator');
    expect(session.agentMcp()).toBeNull();
  });

  it('does not carry one execution’s token into the next', () => {
    const session = new ExecutionCredentialSession();
    session.begin(withCredentials());
    session.end();
    session.begin(featureExecution());
    expect(session.git.apply(base)).toEqual(base);
    expect(session.agentMcp()).toBeNull();
  });

  it('takes a fresher token from a heartbeat, and keeps what was not replaced', () => {
    const session = new ExecutionCredentialSession();
    session.begin(withCredentials());
    expect(session.refresh({ github: { token: 'ghs_the_next_hour' } })).toEqual([
      'ghs_the_next_hour',
    ]);
    expect(session.git.apply(base)[GIT_PASSWORD_ENV]).toBe('ghs_the_next_hour');
    expect(session.agentMcp()).toEqual(MCP);
  });

  it('ignores a refresh that arrives with no execution in flight', () => {
    const session = new ExecutionCredentialSession();
    expect(session.refresh({ github: { token: 'ghs_late_heartbeat' } })).toEqual([]);
    expect(session.git.apply(base)).toEqual(base);
  });
});

describe('what git and gh are actually run with', () => {
  it('hands git the token in its environment, never in the command', async () => {
    const session = new ExecutionCredentialSession();
    session.begin(withCredentials());
    const runner = new ScriptedRunner();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-cred-'));
    try {
      await new Git(runner, new Layout(root), base, session.git).ensureClone(
        IDS.tenant,
        featureExecution().repositories[0]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.command).not.toContain(TOKEN);
      expect(call.env?.[GIT_PASSWORD_ENV]).toBe(TOKEN);
      // Still never allowed to stop and ask.
      expect(call.env?.GIT_TERMINAL_PROMPT).toBe('0');
    }
  });

  it('hands gh the token the same way', async () => {
    const session = new ExecutionCredentialSession();
    session.begin(withCredentials());
    const runner = new ScriptedRunner().when(/pr list/, { stdout: '[]' });
    await new PullRequests(runner, plainRedactor, base, session.gh).findExisting({
      worktree: os.tmpdir(),
      owner: 'acme',
      name: 'api',
      headBranch: 'mvpfy/x',
      baseBranch: 'main',
      title: 't',
      body: 'b',
    });
    expect(runner.calls[0].env?.GH_TOKEN).toBe(TOKEN);
    expect(runner.calls[0].command).not.toContain(TOKEN);
  });

  it('sets the enterprise variable only for a host that is not github.com', () => {
    expect(ghTokenEnv(base, TOKEN, ['github.com']).GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(ghTokenEnv(base, TOKEN, ['git.acme.example']).GH_ENTERPRISE_TOKEN).toBe(TOKEN);
  });

  it('adds to git configuration already in the environment rather than replacing it', () => {
    const env = gitTokenEnv(
      { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' },
      TOKEN,
      ['github.com']
    );
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.helper');
    expect(env.GIT_CONFIG_COUNT).toBe('6');
  });
});

/**
 * The claims above are about an environment. These are about git: whether
 * that environment makes real git behave the way the comments promise, in a
 * repository whose own config is trying to stop it.
 */
describe('real git, in a checkout that is not on our side', () => {
  let repo: string;
  let leak: string;

  const git = (args: string[], env: NodeJS.ProcessEnv, input?: string): string =>
    execFileSync('git', args, {
      cwd: repo,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true', HOME: repo },
      ...(input === undefined ? {} : { input }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  const ask = (host: string, env: NodeJS.ProcessEnv): string => {
    try {
      return git(['credential', 'fill'], env, `protocol=https\nhost=${host}\n\n`);
    } catch (error) {
      // git exits non-zero when nobody could supply a password.
      return String((error as { stdout?: string }).stdout ?? '');
    }
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-hostile-'));
    leak = path.join(repo, 'leaked.txt');
    git(['init', '-q'], base);
    git(['config', 'user.email', 'worker@example.invalid'], base);
    git(['config', 'user.name', 'worker'], base);
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('gives the token to the execution’s host', () => {
    const answer = ask('github.com', gitTokenEnv(base, TOKEN, ['github.com']));
    expect(answer).toContain('username=x-access-token');
    expect(answer).toContain(`password=${TOKEN}`);
  });

  it('gives it to no other host', () => {
    const answer = ask('evil.example', gitTokenEnv(base, TOKEN, ['github.com']));
    expect(answer).not.toContain(TOKEN);
  });

  it('does not tell a helper the repository planted', () => {
    // What a hostile checkout would write: a helper that records whatever
    // git tells it, which after a successful push is the password.
    git(['config', 'credential.helper', `!f() { cat >> ${leak}; }; f`], base);
    const env = gitTokenEnv(base, TOKEN, ['github.com']);
    ask('github.com', env);
    git(
      ['credential', 'approve'],
      env,
      `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n\n`
    );
    expect(fs.existsSync(leak)).toBe(false);
  });

  it('does not run a hook the repository planted, with the token in reach', () => {
    const hooks = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const name of ['pre-commit', 'post-commit', 'commit-msg']) {
      fs.writeFileSync(
        path.join(hooks, name),
        `#!/bin/sh\necho "$${GIT_PASSWORD_ENV}" >> ${leak}\n`,
        { mode: 0o755 }
      );
    }
    fs.writeFileSync(path.join(repo, 'file.txt'), 'work\n');
    const env = gitTokenEnv(base, TOKEN, ['github.com']);
    git(['add', 'file.txt'], env);
    git(['commit', '-q', '-m', 'work'], env);
    expect(fs.existsSync(leak)).toBe(false);
  });
});

describe('operatorGithubToken', () => {
  it('reads what the operator set, and is nothing when they set nothing', () => {
    expect(operatorGithubToken({ GH_TOKEN: ' ghp_x ' })).toBe('ghp_x');
    expect(operatorGithubToken({ GITHUB_TOKEN: 'ghp_y' })).toBe('ghp_y');
    expect(operatorGithubToken({})).toBeNull();
  });
});
