import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommitRecord, RepositoryRef } from '../shared/runner/contract';
import { validRef } from '../shared/runner/validate';
import { CommandRunner } from './exec';
import { Layout, executionBranch } from './layout';

/**
 * Git, as an unattended worker has to do it.
 *
 * Quoting is POSIX here and unconditionally so, unlike the desktop's, which
 * switches on the host platform. The worker runs every command through
 * `/bin/sh`, so host-sensitive quoting would be wrong rather than portable.
 */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Where a fetch puts what it brings back, and the reason this is not the
 * mirror refspec.
 *
 * `+refs/heads/*:refs/heads/*` is the obvious thing to write for a bare
 * clone, and with `--prune` it deletes every local branch the remote does
 * not have — which is precisely the execution branches. Proven against real
 * git: a second execution, or a resume, found its branch silently gone and
 * its commits with it.
 *
 * Fetching into the remote-tracking namespace instead means prune can only
 * ever remove a remote-tracking ref. An execution branch lives in
 * refs/heads/ and nothing touches it but this worker.
 */
const TRACKING_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

const RECORD = '\u001e';
const FIELD = '\u001f';

export interface GitFailure {
  command: string;
  code: number | null;
  message: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly failure: GitFailure
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class Git {
  constructor(
    private readonly runner: CommandRunner,
    private readonly layout: Layout,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private async git(cwd: string, args: string, timeoutMs = 10 * 60_000): Promise<string> {
    const command = `git ${args}`;
    const res = await this.runner.run(command, {
      cwd,
      // Git must never stop to ask. An unattended worker that is prompted for
      // a password hangs until its lease expires, which looks like a crash.
      env: { ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
      timeoutMs,
    });
    if (res.code !== 0) {
      throw new GitError(`git ${args.split(' ')[0]} failed`, {
        command,
        code: res.code,
        message: (res.stderr || res.stdout).trim(),
      });
    }
    return res.stdout;
  }

  /**
   * The execution's own clone, created once per tenant and repository.
   *
   * A bare mirror rather than a working copy: every execution's checkout is a
   * worktree of it, so they share one object store and the second execution
   * in a repository costs no download. It is never a developer's working
   * copy — those belong to a person who may be using them.
   */
  async ensureClone(tenantId: string, repo: RepositoryRef): Promise<string> {
    const dir = this.layout.cloneDir(tenantId, repo.repositoryId);
    if (fs.existsSync(path.join(dir, 'HEAD'))) {
      await this.git(dir, `fetch --prune origin ${posixQuote(TRACKING_REFSPEC)}`);
      return dir;
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await this.git(
      path.dirname(dir),
      `clone --bare ${posixQuote(repo.cloneUrl)} ${posixQuote(dir)}`,
      30 * 60_000
    );
    // A bare clone has no origin fetch refspec by default, and the obvious
    // one to write is the mirror refspec. It is a trap: see TRACKING_REFSPEC.
    await this.git(dir, `config remote.origin.fetch ${posixQuote(TRACKING_REFSPEC)}`);
    await this.git(dir, `fetch --prune origin ${posixQuote(TRACKING_REFSPEC)}`);
    return dir;
  }

  /**
   * The checkout this execution works in.
   *
   * Resumable by design: an execution that is being revised, or that is being
   * picked up after a restart, finds its branch already there and continues
   * on it rather than starting a second one.
   */
  async prepareWorktree(
    tenantId: string,
    executionId: string,
    repo: RepositoryRef
  ): Promise<string> {
    const branch = executionBranch(executionId);
    if (!validRef(branch)) throw new Error(`Refusing an unusable branch name: ${branch}`);
    const clone = await this.ensureClone(tenantId, repo);
    const tree = this.layout.worktreeDir(tenantId, executionId, repo.repositoryId);
    if (fs.existsSync(path.join(tree, '.git'))) {
      await this.git(tree, `checkout ${posixQuote(branch)}`);
      return tree;
    }
    fs.mkdirSync(path.dirname(tree), { recursive: true });
    const exists = await this.hasBranch(clone, branch);
    await this.git(
      clone,
      exists
        ? `worktree add ${posixQuote(tree)} ${posixQuote(branch)}`
        : // From the commit the requirements were written against, not from
          // whatever the default branch happens to be now.
          `worktree add -b ${posixQuote(branch)} ${posixQuote(tree)} ${posixQuote(repo.baseCommit)}`
    );
    return tree;
  }

  async hasBranch(dir: string, branch: string): Promise<boolean> {
    try {
      await this.git(dir, `rev-parse --verify ${posixQuote(`refs/heads/${branch}`)}`);
      return true;
    } catch {
      return false;
    }
  }

  async headCommit(dir: string): Promise<string> {
    return (await this.git(dir, 'rev-parse HEAD')).trim();
  }

  /** True when the checkout holds changes nobody has committed. */
  async hasUncommittedChanges(dir: string): Promise<boolean> {
    return (await this.git(dir, 'status --porcelain')).trim().length > 0;
  }

  /** Commits on this branch that are not in the base commit. */
  async commitsSince(dir: string, baseCommit: string): Promise<CommitRecord[]> {
    const out = await this.git(
      dir,
      `log --no-merges --format=${posixQuote(`%H${FIELD}%s${RECORD}`)} ` +
        `${posixQuote(`${baseCommit}..HEAD`)}`
    );
    return out
      .split(RECORD)
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row) => {
        const [sha, subject] = row.split(FIELD);
        return { sha: (sha ?? '').trim(), subject: (subject ?? '').trim() };
      })
      .filter((c) => /^[0-9a-f]{7,40}$/i.test(c.sha));
  }

  /**
   * Commit whatever the agent left behind, by path.
   *
   * `git add -A` would sweep in anything the agent dropped in the checkout,
   * which on a bad day is a .env it wrote while debugging. The caller passes
   * the paths it means.
   */
  async commit(dir: string, message: string, paths: string[]): Promise<string | null> {
    if (paths.length === 0) return null;
    await this.git(dir, `add -- ${paths.map(posixQuote).join(' ')}`);
    const staged = await this.git(dir, 'diff --cached --name-only');
    if (!staged.trim()) return null;
    await this.git(
      dir,
      `-c user.name=${posixQuote('mvpfy worker')} ` +
        `-c user.email=${posixQuote('worker@mvpfy.local')} ` +
        `commit --no-verify -m ${posixQuote(message)}`
    );
    return this.headCommit(dir);
  }

  /** Everything the agent changed or added, as paths git will take. */
  async changedPaths(dir: string): Promise<string[]> {
    const out = await this.git(dir, 'status --porcelain=v1 -z --untracked-files=all');
    return out
      .split('\0')
      .map((entry) => entry.slice(3).trim())
      .filter(Boolean);
  }

  /**
   * Push the execution branch.
   *
   * The one hard rule in this file: the worker's output is a branch and a
   * pull request, and a push that would land on the base branch is refused
   * rather than attempted. `--force-with-lease` is deliberate too — a
   * reassigned execution must not overwrite what the newer attempt pushed,
   * and a lease failure here is the signal that one did.
   */
  async push(dir: string, branch: string, baseBranch: string): Promise<void> {
    if (branch === baseBranch) {
      throw new Error(`Refusing to push to the base branch ${baseBranch}`);
    }
    if (!validRef(branch)) throw new Error(`Refusing to push an unusable ref: ${branch}`);
    await this.git(
      dir,
      `push --force-with-lease -u origin ${posixQuote(`${branch}:refs/heads/${branch}`)}`
    );
  }

  /** The remote as git has it, for telling GitHub which repository this is. */
  async originUrl(dir: string): Promise<string> {
    return (await this.git(dir, 'remote get-url origin')).trim();
  }
}

/**
 * owner and name out of a clone URL, in the forms GitHub hands out.
 *
 * Read rather than assumed because a pull request has to be reported against
 * the repository GitHub knows, and two repositories in one assignment may
 * share a basename.
 */
export function parseGitHubRepo(url: string): { owner: string; name: string } | null {
  const text = url.trim().replace(/\.git$/, '');
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?<owner>[^/]+)\/(?<name>[^/]+)$/.exec(text);
  if (scp?.groups) return { owner: scp.groups.owner, name: scp.groups.name };
  try {
    const parsed = new URL(text);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
  } catch {
    return null;
  }
}
