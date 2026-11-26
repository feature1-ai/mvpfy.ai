import { posixQuote } from '../shared/shellQuote';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExecutionRepository } from '../shared/runner/contract';
import { validRef } from '../shared/runner/validate';

/** A commit as the worker records it for the pull request body. */
export interface CommitRecord {
  sha: string;
  subject: string;
}
import { CommandRunner } from './exec';
import { Layout, executionBranch } from './layout';
import { CommandAuth, noAuth } from './credentials';

/**
 * Git, as an unattended worker has to do it.
 *
 * Quoting is POSIX here and unconditionally so, unlike the desktop's, which
 * switches on the host platform. The worker runs every command through
 * `/bin/sh`, so host-sensitive quoting would be wrong rather than portable.
 */
export { posixQuote };

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
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Authorises each command as it runs, so a token can change mid-life. */
    private readonly auth: CommandAuth = noAuth
  ) {}

  private async git(cwd: string, args: string, timeoutMs = 10 * 60_000): Promise<string> {
    const command = `git ${args}`;
    const res = await this.runner.run(command, {
      cwd,
      // Git must never stop to ask. An unattended worker that is prompted for
      // a password hangs until its lease expires, which looks like a crash.
      env: this.auth.apply({ ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' }),
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
  async ensureClone(tenantId: string, repo: ExecutionRepository): Promise<string> {
    const dir = this.layout.cloneDir(tenantId, repo.id);
    if (fs.existsSync(path.join(dir, 'HEAD'))) {
      await this.git(dir, `fetch --prune origin ${posixQuote(TRACKING_REFSPEC)}`);
      return dir;
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await this.git(
      path.dirname(dir),
      `clone --bare -- ${posixQuote(repo.url)} ${posixQuote(dir)}`,
      30 * 60_000
    );
    // A bare clone has no origin fetch refspec by default, and the obvious
    // one to write is the mirror refspec. It is a trap: see TRACKING_REFSPEC.
    await this.git(dir, `config remote.origin.fetch ${posixQuote(TRACKING_REFSPEC)}`);
    await this.git(dir, `fetch --prune origin ${posixQuote(TRACKING_REFSPEC)}`);
    return dir;
  }

  /**
   * The commit the base branch is actually on, right now.
   *
   * Feature1 sends a base branch and not a commit, so the worker resolves
   * it and reports the sha it used — which is the only way the record says
   * what the work was actually built on rather than what it was aimed at.
   */
  async baseCommit(tenantId: string, repo: ExecutionRepository): Promise<string> {
    const clone = await this.ensureClone(tenantId, repo);
    const ref = `refs/remotes/origin/${repo.base_branch}`;
    return (await this.git(clone, `rev-parse ${posixQuote(ref)}`)).trim();
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
    repo: ExecutionRepository,
    /** The base commit the execution recorded; a new branch starts here. */
    startPoint?: string
  ): Promise<string> {
    const branch = executionBranch(executionId);
    if (!validRef(branch)) throw new Error(`Refusing an unusable branch name: ${branch}`);
    const clone = await this.ensureClone(tenantId, repo);
    const tree = this.layout.worktreeDir(tenantId, executionId, repo.id);
    if (fs.existsSync(path.join(tree, '.git'))) {
      await this.git(tree, `checkout ${posixQuote(branch)}`);
      return tree;
    }
    fs.mkdirSync(path.dirname(tree), { recursive: true });
    // A worktree whose directory went missing (a cleaned volume, a crash
    // mid-delete) stays registered, and `worktree add` then refuses the path
    // for good. Pruning first forgets registrations with nothing behind them.
    await this.git(clone, 'worktree prune');
    const exists = await this.hasBranch(clone, branch);
    await this.git(
      clone,
      exists
        ? `worktree add ${posixQuote(tree)} ${posixQuote(branch)}`
        : // From the base commit the execution resolved once and reports —
          // not the branch tip now, which may have moved since — falling
          // back to that tip when no commit was recorded.
          `worktree add -b ${posixQuote(branch)} ${posixQuote(tree)} ` +
            posixQuote(
              startPoint && /^[0-9a-f]{7,40}$/i.test(startPoint)
                ? startPoint
                : `refs/remotes/origin/${repo.base_branch}`
            )
    );
    return tree;
  }

  /**
   * Remove an execution's checkout once its work is handed over.
   *
   * Only the working tree goes: the branch stays in the clone (and on the
   * remote), so a revision recreates the checkout from it. Without this every
   * execution left a full checkout behind and the volume only ever grew.
   */
  async removeWorktree(tenantId: string, executionId: string, repositoryId: string): Promise<void> {
    const clone = this.layout.cloneDir(tenantId, repositoryId);
    const tree = this.layout.worktreeDir(tenantId, executionId, repositoryId);
    // --force discards whatever is in the tree, so it must be one of ours.
    if (!this.layout.contains(tree)) throw new Error(`Refusing to remove ${tree}`);
    if (fs.existsSync(path.join(clone, 'HEAD')) && fs.existsSync(tree)) {
      await this.git(clone, `worktree remove --force ${posixQuote(tree)}`);
    }
    if (fs.existsSync(path.join(clone, 'HEAD'))) await this.git(clone, 'worktree prune');
  }

  /**
   * A checkout of what a branch on the remote holds now, detached, at a
   * directory of the caller's choosing. For looking at work, never for
   * making it: there is no local branch to commit to or push.
   *
   * Made afresh each time, so it is always the branch's latest commit.
   */
  async detachedCheckout(
    tenantId: string,
    repo: ExecutionRepository,
    branch: string,
    dir: string
  ): Promise<string> {
    if (!validRef(branch)) throw new Error(`Refusing an unusable branch name: ${branch}`);
    if (!this.layout.contains(dir)) throw new Error(`Refusing to check out to ${dir}`);
    const clone = await this.ensureClone(tenantId, repo);
    if (fs.existsSync(dir)) {
      await this.git(clone, `worktree remove --force ${posixQuote(dir)}`).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await this.git(clone, 'worktree prune');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const ref = `refs/remotes/origin/${branch}`;
    await this.git(clone, `worktree add --detach ${posixQuote(dir)} ${posixQuote(ref)}`);
    return (await this.git(dir, 'rev-parse HEAD')).trim();
  }

  /** Whether the remote has this branch, as of a fetch made now. */
  async remoteBranchExists(
    tenantId: string,
    repo: ExecutionRepository,
    branch: string
  ): Promise<boolean> {
    if (!validRef(branch)) return false;
    const clone = await this.ensureClone(tenantId, repo);
    try {
      await this.git(
        clone,
        `rev-parse --verify --quiet ${posixQuote(`refs/remotes/origin/${branch}`)}`
      );
      return true;
    } catch {
      return false;
    }
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
  /**
   * Work that never reached the branch. A withheld credential is not work.
   */
  async hasUncommittedChanges(dir: string): Promise<boolean> {
    return (await this.uncommitted(dir)).paths.length > 0;
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

  /**
   * Everything the agent changed or added, as paths git will take — less any
   * new file that looks like a credential (see parseStatus).
   */
  /**
   * Everything the agent left behind, split into what may be committed and
   * what is being withheld because it looks like a credential.
   *
   * One reader, because there used to be two and they disagreed. This one
   * withheld an untracked `.env`; `hasUncommittedChanges` asked git again
   * without the filter and still saw it, so the publish step decided work
   * had been left behind and failed the whole execution — on exactly the
   * case the withholding exists for. A secret that is skipped must not also
   * look like unfinished work.
   */
  async uncommitted(dir: string): Promise<{ paths: string[]; withheld: string[] }> {
    const out = await this.git(dir, 'status --porcelain=v1 -z --untracked-files=all');
    return parseStatus(out);
  }

  async changedPaths(dir: string): Promise<string[]> {
    return (await this.uncommitted(dir)).paths;
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

  /**
   * Push what a detached checkout holds onto a branch of the remote: a test
   * link's checkout after a change made in its chat. Never forced — when
   * the branch has moved on, the push fails and nothing is overwritten —
   * and never onto the base branch.
   */
  async pushHead(dir: string, branch: string, baseBranch: string): Promise<void> {
    if (branch === baseBranch) throw new Error(`Refusing to push to the base branch ${baseBranch}`);
    if (!validRef(branch)) throw new Error(`Refusing to push an unusable ref: ${branch}`);
    await this.git(dir, `push origin ${posixQuote(`HEAD:refs/heads/${branch}`)}`);
  }

  /** Undo one commit with a new one, leaving history as it was. */
  async revert(dir: string, sha: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`Not a commit: ${sha}`);
    await this.git(
      dir,
      `-c user.name=${posixQuote('mvpfy worker')} -c user.email=${posixQuote('worker@mvpfy.local')} ` +
        `revert --no-edit ${sha}`
    );
    return this.headCommit(dir);
  }

  /** Whether this checkout has this commit. */
  async hasCommit(dir: string, sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
    return this.git(dir, `cat-file -e ${sha}^{commit}`).then(
      () => true,
      () => false
    );
  }

  /** Keep a path out of every commit made in this checkout, whatever its .gitignore says. */
  async exclude(dir: string, pattern: string): Promise<void> {
    const file = (await this.git(dir, 'rev-parse --git-path info/exclude')).trim();
    const at = path.isAbsolute(file) ? file : path.join(dir, file);
    const kept = fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : '';
    if (kept.split('\n').includes(pattern)) return;
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.appendFileSync(at, `${kept && !kept.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  }

  /** The remote as git has it, for telling GitHub which repository this is. */
  async originUrl(dir: string): Promise<string> {
    return (await this.git(dir, 'remote get-url origin')).trim();
  }
}

/**
 * A file name that holds a secret, not code: `.env` and its variants, keys and
 * certificates, package-manager and cloud credentials. Templates meant to be
 * committed (`.env.example`) are not.
 */
export function looksLikeSecret(file: string): boolean {
  const parts = file.split('/');
  const name = (parts[parts.length - 1] ?? '').toLowerCase();
  if (parts.slice(0, -1).some((dir) => dir === '.ssh' || dir === '.aws' || dir === '.gnupg')) {
    return true;
  }
  if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist)$/.test(name);
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx)$/.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) return !name.endsWith('.pub');
  return ['.npmrc', '.netrc', '.pypirc', '.git-credentials', 'credentials.json'].includes(name);
}

/**
 * `git status --porcelain=v1 -z` read as the paths to commit.
 *
 * Each entry is `XY path`, except a rename or copy, which is `XY new` followed
 * by the original path as an entry of its own — taking that one as `XY path`
 * too cut three characters off it, and `git add` then failed the repository.
 * Only the new side is taken; the rename is already staged, removal and all.
 *
 * Untracked files are new work and are committed, with one exception: a new
 * file that looks like a credential (looksLikeSecret) is withheld. The agent
 * runs with permission checks off and sometimes writes a `.env` while
 * debugging; one the repository does not ignore would otherwise be pushed in
 * the pull request. Tracked files are the repository's own choice and pass.
 */
export function parseStatus(out: string): { paths: string[]; withheld: string[] } {
  const entries = out.split('\0');
  const paths: string[] = [];
  const withheld: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code === '??' && looksLikeSecret(file)) {
      withheld.push(file);
      continue;
    }
    paths.push(file);
    // The original's own entry: consumed, not staged. Porcelain only reports
    // R or C once the rename is in the index, so the removal is already
    // staged — and `git add` of a path in neither index nor tree fails.
    if (code.includes('R') || code.includes('C')) i++;
  }
  return { paths, withheld };
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
