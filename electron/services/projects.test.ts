import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isWorktreePath, PROJECTS_DIR, setLinkedRoots, WORKTREES_DIR } from '../paths';
import {
  addRemoteCommand,
  checkoutDefaultCommand,
  commitFeatureWorkCommand,
  deleteFeatureFiles,
  ensureInitialCommit,
  featureConflicts,
  featureGitStatus,
  finishMergeCommand,
  pushFeatureBranchCommand,
  isRemoteUrl,
  checkoutFeatureCommand,
  featureCheckedOut,
  mergeTrunkCommand,
  raisePrCommand,
  workspaceIsEmpty,
  repoSyncCommand,
  worktreeAddCommand,
  worktreePathFor,
  worktreeRemoveCommand,
} from './projects';
import { IS_WIN, shellQuote, spawnShellSync } from './shell';

afterEach(() => setLinkedRoots([]));

describe('repoSyncCommand', () => {
  it('builds one pull per managed repo dir, joined with &&', () => {
    const a = path.join(PROJECTS_DIR, 'stack', 'api');
    const b = path.join(PROJECTS_DIR, 'stack', 'web');
    const cmd = repoSyncCommand([a, b]);
    expect(cmd).toBe(
      `echo ${shellQuote('── api')} && git -C ${shellQuote(a)} pull --ff-only && ` +
        `echo ${shellQuote('── web')} && git -C ${shellQuote(b)} pull --ff-only`
    );
  });

  it.runIf(!IS_WIN)('single-quotes every interpolated path segment', () => {
    const dir = path.join(PROJECTS_DIR, 'my app; $(evil)');
    const cmd = repoSyncCommand([dir]);
    expect(cmd).toContain(`git -C '${dir}' pull --ff-only`);
    expect(cmd).toContain("echo '── my app; $(evil)'");
    // The path never appears unquoted.
    expect(cmd).not.toContain(`git -C ${dir}`);
  });

  it('accepts dirs under a registered linked root', () => {
    setLinkedRoots(['/Users/pm/code/shop']);
    const dir = '/Users/pm/code/shop/api';
    expect(repoSyncCommand([dir])).toContain(`git -C ${shellQuote(dir)} pull --ff-only`);
  });

  it('rejects any dir outside managed and linked workspaces', () => {
    expect(() => repoSyncCommand(['/etc'])).toThrow(/restricted to managed and linked/);
    expect(() => repoSyncCommand([path.join(PROJECTS_DIR, 'ok'), '/Users/pm/other'])).toThrow(
      /restricted to managed and linked/
    );
  });

  it('rejects traversal that escapes the managed root', () => {
    const sneaky = path.join(PROJECTS_DIR, 'app', '..', '..', '..', 'Documents');
    expect(() => repoSyncCommand([sneaky])).toThrow(/restricted to managed and linked/);
  });
});

describe('raisePrCommand', () => {
  const dir = path.join(PROJECTS_DIR, 'shop', 'api');

  it('refuses to raise a pull request with no commits behind it', () => {
    // GitHub rejects an empty PR outright, so this must fail here, clearly,
    // rather than as a 422 halfway through a run.
    expect(() => raisePrCommand([dir], 'mvpfy/invoice-export', 'Invoice export', 'body')).toThrow(
      /Nothing to raise: mvpfy\/invoice-export has no commits in api/i
    );
  });

  it('rejects any directory outside a managed or linked workspace', () => {
    expect(() => raisePrCommand(['/etc'], 'mvpfy/x', 't', 'b')).toThrow(
      /restricted to managed and linked/
    );
  });

  it('keeps the whole command on one line, whatever the body and title say', () => {
    // A pull request body is many lines. Put one on the command line and
    // cmd.exe ends the quoted string at the newline and runs the rest of the
    // body as commands, so the push succeeds and the pull request never
    // happens — Windows only, which is how it survived so long.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-pr-'));
    setLinkedRoots([root]);
    const git = (args: string) =>
      execFileSync('git', args.split(' '), { cwd: root, stdio: 'ignore' });
    git('init -b main');
    git('config user.email pm@example.com');
    git('config user.name PM');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    git('add -A');
    git('commit -m first');
    git('checkout -b mvpfy/paging');
    fs.writeFileSync(path.join(root, 'a.txt'), 'two');
    git('add -A');
    git('commit -m second');

    const cmd = raisePrCommand(
      [root],
      'mvpfy/paging',
      'Page the list\nserver side',
      path.join(root, 'body.md')
    );
    expect(cmd).not.toMatch(/[\r\n]/);
    // The text itself is never an argument; only the path to it is.
    expect(cmd).toContain('--body-file');
    expect(cmd).toContain(shellQuote('Page the list server side'));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('worktreePathFor', () => {
  it('keeps every checkout inside the directory mvpfy owns', () => {
    const p = worktreePathFor(
      'shop-a1b2c3',
      'invoice-export',
      '/Users/pm/.mvpfy/projects/shop/api'
    );
    expect(isWorktreePath(p)).toBe(true);
    expect(p.startsWith(WORKTREES_DIR + path.sep)).toBe(true);
  });

  it('separates features, repos and projects that share a name', () => {
    const a = worktreePathFor('shop-a1b2c3', 'invoice-export', '/x/api');
    const b = worktreePathFor('shop-d4e5f6', 'invoice-export', '/x/api');
    const c = worktreePathFor('shop-a1b2c3', 'bulk-download', '/x/api');
    const d = worktreePathFor('shop-a1b2c3', 'invoice-export', '/x/web');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('cannot be steered out of that directory by its inputs', () => {
    // Slashes and dots in a slug are flattened, not followed.
    const p = worktreePathFor('../../etc', '../../..', '/x/../../passwd');
    expect(isWorktreePath(p)).toBe(true);
    expect(p).not.toContain('..');
  });
});

describe('worktree commands', () => {
  it('refuses repositories outside a managed or linked workspace', () => {
    expect(() => worktreeAddCommand('k', 'f', ['/etc'], 'mvpfy/f')).toThrow(
      /restricted to managed and linked/
    );
    expect(() => worktreeRemoveCommand('k', 'f', ['/etc'])).toThrow(
      /restricted to managed and linked/
    );
  });

  it('says so rather than failing when there is nothing to remove', () => {
    const dir = path.join(PROJECTS_DIR, 'shop', 'api');
    expect(worktreeRemoveCommand('k', 'f', [dir])).toContain('Nothing to remove');
  });
});

describe('checkoutFeatureCommand', () => {
  const dir = path.join(PROJECTS_DIR, 'shop', 'api');

  it('detaches, because the worktree already holds that branch', () => {
    // `git checkout <branch>` is refused while a worktree has it checked out,
    // which is always true of a feature being worked on. Detaching is allowed,
    // and read-only is the right shape for a copy that only runs the product.
    setLinkedRoots([]);
    expect(() => checkoutFeatureCommand(['/etc'], 'mvpfy/x')).toThrow(
      /restricted to managed and linked/
    );
  });

  it('says which branch is missing rather than failing mid-checkout', () => {
    expect(() => checkoutFeatureCommand([dir], 'mvpfy/never-implemented')).toThrow(
      /No repository has a mvpfy\/never-implemented branch/
    );
  });

  it('refuses directories outside a managed or linked workspace', () => {
    expect(() => checkoutDefaultCommand(['/etc'])).toThrow(/restricted to managed and linked/);
  });
});

describe('featureCheckedOut', () => {
  it('refuses to answer for a directory outside a managed or linked workspace', () => {
    // Never "yes" on a repository mvpfy has no business reading.
    expect(featureCheckedOut(['/etc'], 'mvpfy/x')).toBe(false);
  });

  it('is false when no repository has the branch at all', () => {
    // Nothing to be checked out to, so the workspace is certainly not on it.
    expect(featureCheckedOut([path.join(PROJECTS_DIR, 'shop', 'api')], 'mvpfy/nope')).toBe(false);
  });
});

describe('ensureInitialCommit', () => {
  const repo = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-init-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    return dir;
  };

  it('makes a repository with no commits able to hold a worktree', () => {
    // `git worktree add -b` fails outright on an unborn HEAD, and every
    // feature starts by making one — so a brand-new repository could not be
    // built in at all, and said so mid-run in git's words.
    const dir = repo();
    setLinkedRoots([dir]);
    const wt = (name: string) => path.join(dir, '..', `${path.basename(dir)}-${name}`);
    expect(() =>
      execFileSync('git', ['worktree', 'add', wt('a'), '-b', 'mvpfy/x'], {
        cwd: dir,
        stdio: 'ignore',
      })
    ).toThrow();

    ensureInitialCommit(dir);

    execFileSync('git', ['worktree', 'add', wt('b'), '-b', 'mvpfy/y'], {
      cwd: dir,
      stdio: 'ignore',
    });
    expect(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).toString().trim()
    ).toBe('1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('commits without a git identity configured, which a new machine has not', () => {
    // git refuses to commit without a name and an email, and the machine
    // someone is setting mvpfy up on is exactly the one that has never been
    // given them. Pointing git at empty config files is how a real fresh
    // machine looks; the fallback identity is only used when there is none.
    const dir = repo();
    const globalCfg = process.env.GIT_CONFIG_GLOBAL;
    const systemCfg = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      ensureInitialCommit(dir);
      expect(
        execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).toString().trim()
      ).toBe('1');
    } finally {
      if (globalCfg === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = globalCfg;
      if (systemCfg === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = systemCfg;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a repository that already has history alone', () => {
    const dir = repo();
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git(['config', 'user.email', 'pm@example.com']);
    git(['config', 'user.name', 'PM']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    git(['add', '-A']);
    git(['commit', '-m', 'first']);
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    ensureInitialCommit(dir);

    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('workspaceIsEmpty', () => {
  const repo = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-empty-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'pm@example.com'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'PM'], { cwd: dir, stdio: 'ignore' });
    return dir;
  };
  const commit = (dir: string, file: string) => {
    fs.writeFileSync(path.join(dir, file), 'x');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', file], { cwd: dir, stdio: 'ignore' });
  };

  it('calls a repository with nothing tracked empty', () => {
    const dir = repo();
    setLinkedRoots([dir]);
    expect(workspaceIsEmpty([dir])).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not count mvpfy own files as a product', () => {
    // A workspace holding only a plan and a compose file mvpfy generated has
    // no product in it — telling the agent to match its patterns would mean
    // matching the patterns of a yaml file mvpfy wrote.
    const dir = repo();
    setLinkedRoots([dir]);
    commit(dir, 'mvpfy.yml');
    commit(dir, 'mvpfy-plan.paging.json');
    expect(workspaceIsEmpty([dir])).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is not empty once there is any real code', () => {
    const dir = repo();
    setLinkedRoots([dir]);
    commit(dir, 'index.ts');
    expect(workspaceIsEmpty([dir])).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is not empty when any one repository of several holds code', () => {
    const a = repo();
    const b = repo();
    setLinkedRoots([a, b]);
    commit(b, 'server.ts');
    expect(workspaceIsEmpty([a, b])).toBe(false);
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
});

describe('mergeTrunkCommand', () => {
  it('produces nothing when the feature has no checkout to merge in', () => {
    // The branch is checked out in the worktree; the workspace copy is
    // detached at one of its commits and cannot move it. No worktree, nothing
    // to do — and the caller must treat that as "nothing", not as a failure.
    const dir = path.join(PROJECTS_DIR, 'shop', 'api');
    expect(mergeTrunkCommand('shop-a1b2c3', 'paging', [dir], 'mvpfy/paging')).toBe('');
  });

  it('refuses a directory outside a managed or linked workspace', () => {
    setLinkedRoots([]);
    expect(() => mergeTrunkCommand('k', 'paging', ['/etc'], 'mvpfy/paging')).toThrow(
      /restricted to managed and linked/
    );
  });
});

describe('isRemoteUrl', () => {
  it('accepts the forms GitHub actually hands people', () => {
    expect(isRemoteUrl('https://github.com/acme/app.git')).toBe(true);
    expect(isRemoteUrl('https://github.com/acme/app')).toBe(true);
    expect(isRemoteUrl('git@github.com:acme/app.git')).toBe(true);
    expect(isRemoteUrl('ssh://git@ssh.github.com:443/acme/app.git')).toBe(true);
  });

  it('refuses what would be handed to a shell as a remote', () => {
    // The value reaches `git remote add`; anything with whitespace in it is
    // not a remote, whatever else it might be.
    expect(isRemoteUrl('https://github.com/acme/app && rm -rf /')).toBe(false);
    expect(isRemoteUrl('')).toBe(false);
    expect(isRemoteUrl('   ')).toBe(false);
    expect(isRemoteUrl('my repo')).toBe(false);
  });

  it('refuses a half-typed address rather than failing at the first push', () => {
    expect(isRemoteUrl('https://github.com')).toBe(false);
    expect(isRemoteUrl('github.com/acme/app')).toBe(false);
  });
});

describe('commitFeatureWorkCommand', () => {
  it('refuses a directory outside a managed or linked workspace', () => {
    setLinkedRoots([]);
    expect(() => commitFeatureWorkCommand(['/etc'], 'k', 'paging', 'mvpfy/paging', 'msg')).toThrow(
      /restricted to managed and linked/
    );
  });

  it('says there is nothing to commit in rather than producing an empty command', () => {
    // No checkout means the feature was never implemented. An empty command
    // would "succeed" and leave the builder believing work had been committed.
    const dir = path.join(PROJECTS_DIR, 'shop', 'api');
    expect(() =>
      commitFeatureWorkCommand([dir], 'shop-a1b2c3', 'paging', 'mvpfy/paging', 'msg')
    ).toThrow(/implement something first/i);
  });
});

describe('featureGitStatus', () => {
  it('reports a repository it is not allowed to read as absent, not as clean', () => {
    setLinkedRoots([]);
    expect(featureGitStatus(['/etc'], 'k', 'paging', 'mvpfy/paging')).toEqual([]);
  });
});

describe('addRemoteCommand', () => {
  const dir = path.join(PROJECTS_DIR, 'shop', 'api');

  it('pushes as well as wiring up, so a bad address is heard now', () => {
    // `git remote add` always succeeds. Without the push, a wrong address or a
    // repository nobody can write to goes unnoticed until the pull request.
    const cmd = addRemoteCommand(dir, 'https://github.com/acme/app.git');
    expect(cmd).toContain('remote add origin');
    expect(cmd).toContain('push -u origin HEAD');
  });

  it('replaces an existing origin rather than failing on one', () => {
    // A project pointed at the wrong place is exactly who needs this.
    expect(addRemoteCommand(dir, 'https://github.com/acme/app.git')).toContain(
      'remote remove origin'
    );
  });

  it('refuses an address that is not one, before git sees it', () => {
    expect(() => addRemoteCommand(dir, 'not a url')).toThrow(/does not look like a git remote/);
    expect(() => addRemoteCommand(dir, '')).toThrow(/does not look like a git remote/);
  });

  it('refuses a directory outside a managed or linked workspace', () => {
    setLinkedRoots([]);
    expect(() => addRemoteCommand('/etc', 'https://github.com/acme/app.git')).toThrow(
      /managed and linked/
    );
  });
});

describe('deleteFeatureFiles', () => {
  const workspace = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-del-'));
    setLinkedRoots([dir]);
    return dir;
  };

  it('removes what mvpfy wrote about the feature', () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, 'mvpfy-plan.paging.json'), '{}');
    fs.writeFileSync(path.join(ws, 'mvpfy-spec.paging.md'), '# Paging');
    fs.mkdirSync(path.join(ws, 'mvpfy-design/paging'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'mvpfy-design/paging/a.png'), 'x');

    expect(deleteFeatureFiles(ws, '', 'paging').removed).toHaveLength(3);
    expect(fs.existsSync(path.join(ws, 'mvpfy-plan.paging.json'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'mvpfy-design/paging'))).toBe(false);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('leaves another feature alone', () => {
    // Slugs share prefixes — feature1-wat-f-1 and feature1-wat-f-1-2 — and a
    // delete that matched loosely would take the wrong board with it.
    const ws = workspace();
    fs.writeFileSync(path.join(ws, 'mvpfy-plan.paging.json'), '{}');
    fs.writeFileSync(path.join(ws, 'mvpfy-plan.paging-2.json'), '{}');
    deleteFeatureFiles(ws, '', 'paging');
    expect(fs.existsSync(path.join(ws, 'mvpfy-plan.paging-2.json'))).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('refuses the unnamed plan, which is the whole project', () => {
    // An empty slug names mvpfy-plan.json — the legacy single plan, not one
    // feature among several.
    expect(() => deleteFeatureFiles(workspace(), '', '  ')).toThrow(/unnamed plan/);
  });

  it('refuses a workspace it does not own', () => {
    setLinkedRoots([]);
    expect(() => deleteFeatureFiles('/etc', '', 'paging')).toThrow(/managed and linked/);
  });

  it('says nothing was there rather than failing on a feature already gone', () => {
    expect(deleteFeatureFiles(workspace(), '', 'paging').removed).toEqual([]);
  });
});

/**
 * The whole point of updating a feature: work that landed on the trunk after
 * the feature branched ends up in the feature's checkout, without the builder
 * pulling anything first and without the workspace moving.
 */
describe('updating a feature from the trunk', () => {
  const made: string[] = [];
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  const work = (): { dir: string; origin: string } => {
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-origin-'));
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: origin, stdio: 'ignore' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-trunk-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    git(dir, 'config', 'user.email', 'pm@example.com');
    git(dir, 'config', 'user.name', 'PM');
    fs.writeFileSync(path.join(dir, 'index.ts'), 'start\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'start');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-u', 'origin', 'main');
    made.push(origin, dir);
    return { dir, origin };
  };
  /** Somebody else lands a commit on the trunk, elsewhere. */
  const landOnTrunk = (origin: string, file: string, body: string) => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-other-'));
    execFileSync('git', ['clone', origin, other], { stdio: 'ignore' });
    git(other, 'config', 'user.email', 'dev@example.com');
    git(other, 'config', 'user.name', 'Dev');
    fs.writeFileSync(path.join(other, file), body);
    git(other, 'add', '-A');
    git(other, 'commit', '-m', file);
    git(other, 'push', 'origin', 'main');
    made.push(other);
  };
  const checkout = (dir: string, key: string, slug: string, branch: string): string => {
    const tree = worktreePathFor(key, slug, dir);
    fs.mkdirSync(path.dirname(tree), { recursive: true });
    git(dir, 'worktree', 'add', tree, '-b', branch);
    made.push(path.join(WORKTREES_DIR, key));
    return tree;
  };

  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('brings in what landed on the trunk after the feature branched', () => {
    const { dir, origin } = work();
    setLinkedRoots([dir]);
    const key = `test-${path.basename(dir)}`;
    const tree = checkout(dir, key, 'paging', 'mvpfy/paging');
    landOnTrunk(origin, 'pricing.ts', 'landed\n');

    // Nobody has fetched, so the feature does not know it is behind yet — the
    // merge asks the remote itself rather than trusting the last pull.
    const cmd = mergeTrunkCommand(key, 'paging', [dir], 'mvpfy/paging');
    expect(cmd).toContain('fetch origin');
    expect(spawnShellSync(cmd, { encoding: 'utf8', timeout: 60_000 }).status).toBe(0);

    expect(fs.existsSync(path.join(tree, 'pricing.ts'))).toBe(true);
    const [row] = featureGitStatus([dir], key, 'paging', 'mvpfy/paging');
    expect(row.behind).toBe(0);
    expect(row.trunk).toBe('origin/main');
    expect(row.mergeInProgress).toBe(false);
  }, 60_000);

  it('counts how far behind the trunk the feature has fallen', () => {
    const { dir, origin } = work();
    setLinkedRoots([dir]);
    const key = `test-${path.basename(dir)}`;
    checkout(dir, key, 'paging', 'mvpfy/paging');
    landOnTrunk(origin, 'pricing.ts', 'landed\n');
    landOnTrunk(origin, 'tax.ts', 'landed\n');
    // Measured against the remote's trunk, which is what everyone else has
    // pushed — so it has to be fetched to be seen.
    git(dir, 'fetch', 'origin', 'main');

    const [row] = featureGitStatus([dir], key, 'paging', 'mvpfy/paging');
    expect(row.behind).toBe(2);
    expect(row.ahead).toBe(0);
  }, 60_000);

  it('leaves the checkout as it was when the trunk conflicts with the feature', () => {
    const { dir, origin } = work();
    setLinkedRoots([dir]);
    const key = `test-${path.basename(dir)}`;
    const tree = checkout(dir, key, 'paging', 'mvpfy/paging');
    // The same line, changed both here and on the trunk.
    fs.writeFileSync(path.join(tree, 'index.ts'), 'feature\n');
    git(tree, 'config', 'user.email', 'pm@example.com');
    git(tree, 'config', 'user.name', 'PM');
    git(tree, 'add', '-A');
    git(tree, 'commit', '-m', 'feature');
    landOnTrunk(origin, 'index.ts', 'trunk\n');

    const res = spawnShellSync(mergeTrunkCommand(key, 'paging', [dir], 'mvpfy/paging'), {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(`${res.stdout}${res.stderr}`).toContain('could not merge');
    // Half-merged is worse than not merged: every later run in the checkout
    // would fail on the merge instead of on what it was asked to do.
    const [row] = featureGitStatus([dir], key, 'paging', 'mvpfy/paging');
    expect(row.mergeInProgress).toBe(false);
    expect(fs.readFileSync(path.join(tree, 'index.ts'), 'utf8')).toBe('feature\n');
  }, 60_000);
  /** A conflict the builder asked to have resolved, rather than one in passing. */
  const conflicted = (): { dir: string; origin: string; key: string; tree: string } => {
    const { dir, origin } = work();
    setLinkedRoots([dir]);
    const key = `test-${path.basename(dir)}`;
    const tree = checkout(dir, key, 'paging', 'mvpfy/paging');
    fs.writeFileSync(path.join(tree, 'index.ts'), 'feature\n');
    git(tree, 'add', '-A');
    git(tree, 'commit', '-m', 'feature');
    landOnTrunk(origin, 'index.ts', 'trunk\n');
    spawnShellSync(mergeTrunkCommand(key, 'paging', [dir], 'mvpfy/paging', 'keep'), {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { dir, origin, key, tree };
  };
  const rev = (dir: string, ref: string) =>
    execFileSync('git', ['rev-parse', ref], { cwd: dir, encoding: 'utf8' }).trim();

  it('leaves the conflict open for whoever asked to have it resolved', () => {
    const { dir, key, tree } = conflicted();
    expect(featureConflicts([dir], key, 'paging')).toEqual([
      { repo: dir, worktree: tree, files: ['index.ts'] },
    ]);
    // Nothing may be committed while git still calls a file unmerged: the
    // resolution is the point, and a merge commit is what claims there was one.
    // The repository puts itself back instead, and says why.
    const refused = finishMergeCommand(key, 'paging', [dir], 'mvpfy/paging', 'commit');
    expect(refused).toContain('merge --abort');
    expect(refused).toContain('could not be resolved');
    expect(refused).not.toContain('commit --no-edit');
    // And the way back is always open.
    spawnShellSync(finishMergeCommand(key, 'paging', [dir], 'mvpfy/paging', 'abort'), {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(featureConflicts([dir], key, 'paging')).toEqual([]);
    expect(fs.readFileSync(path.join(tree, 'index.ts'), 'utf8')).toBe('feature\n');
  }, 60_000);

  it('puts a repository back rather than recording a resolution with markers in it', () => {
    // `git add` will mark a file resolved with the markers still in it, so
    // "git reports nothing unmerged" is not on its own evidence of anything.
    const { dir, key, tree } = conflicted();
    fs.writeFileSync(
      path.join(tree, 'index.ts'),
      '<<<<<<< HEAD\nfeature\n=======\ntrunk\n>>>>>>> origin/main\n'
    );
    git(tree, 'add', 'index.ts');
    const refused = finishMergeCommand(key, 'paging', [dir], 'mvpfy/paging', 'commit');
    expect(refused).toContain('conflict markers');
    expect(refused).toContain('merge --abort');
    expect(refused).not.toContain('commit --no-edit');
    // And it goes back for real, rather than only saying so.
    expect(spawnShellSync(refused, { encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    expect(featureConflicts([dir], key, 'paging')).toEqual([]);
    expect(fs.readFileSync(path.join(tree, 'index.ts'), 'utf8')).toBe('feature\n');
  }, 60_000);

  it('commits the resolution on the feature branch and leaves the trunk untouched', () => {
    const { dir, origin, key, tree } = conflicted();
    const trunkWas = rev(dir, 'origin/main');
    const mainWas = rev(dir, 'main');
    const originWas = rev(origin, 'main');
    // Both sides kept, which is what resolving means here.
    fs.writeFileSync(path.join(tree, 'index.ts'), 'feature\ntrunk\n');
    git(tree, 'add', 'index.ts');

    const cmd = finishMergeCommand(key, 'paging', [dir], 'mvpfy/paging', 'commit');
    expect(spawnShellSync(cmd, { encoding: 'utf8', timeout: 60_000 }).status).toBe(0);

    expect(featureConflicts([dir], key, 'paging')).toEqual([]);
    expect(fs.readFileSync(path.join(tree, 'index.ts'), 'utf8')).toBe('feature\ntrunk\n');
    // The merge commit is on the feature's own branch, with both histories
    // behind it — and every copy of the trunk is exactly where it was.
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: tree,
        encoding: 'utf8',
      }).trim()
    ).toBe('mvpfy/paging');
    expect(rev(dir, 'origin/main')).toBe(trunkWas);
    expect(rev(dir, 'main')).toBe(mainWas);
    expect(rev(origin, 'main')).toBe(originWas);

    const [row] = featureGitStatus([dir], key, 'paging', 'mvpfy/paging');
    expect(row.behind).toBe(0);
    expect(row.mergeInProgress).toBe(false);
    // The feature's own work is still ahead of the trunk, not swallowed by it.
    expect(row.ahead).toBeGreaterThan(0);
  }, 60_000);
  it('sends the updated branch to the remote that already has it', () => {
    const { dir, origin } = work();
    setLinkedRoots([dir]);
    const key = `test-${path.basename(dir)}`;
    const tree = checkout(dir, key, 'paging', 'mvpfy/paging');
    fs.writeFileSync(path.join(tree, 'paging.ts'), 'feature\n');
    git(tree, 'add', '-A');
    git(tree, 'commit', '-m', 'feature');
    // Published, as raising its pull request would have done.
    git(tree, 'push', '-u', 'origin', 'mvpfy/paging');
    landOnTrunk(origin, 'pricing.ts', 'landed\n');
    spawnShellSync(mergeTrunkCommand(key, 'paging', [dir], 'mvpfy/paging', 'keep'), {
      encoding: 'utf8',
      timeout: 60_000,
    });

    const cmd = pushFeatureBranchCommand([dir], 'mvpfy/paging');
    expect(spawnShellSync(cmd, { encoding: 'utf8', timeout: 60_000 }).status).toBe(0);

    // The remote's copy of the feature now holds the merge, and its trunk is
    // untouched by any of it.
    expect(rev(origin, 'mvpfy/paging')).toBe(rev(dir, 'mvpfy/paging'));
    expect(rev(origin, 'main')).not.toBe(rev(dir, 'mvpfy/paging'));
    // Nothing left to send, so there is nothing to run.
    expect(pushFeatureBranchCommand([dir], 'mvpfy/paging')).toBe('');
  }, 60_000);

  it('does not publish a branch the remote has never seen', () => {
    // Publishing a feature is what raising its pull request does. A branch
    // appearing on the team's remote with no pull request behind it is noise
    // nobody asked for, so an update stays local until there is something to
    // update.
    const { dir } = work();
    setLinkedRoots([dir]);
    const key = `test-${path.basename(dir)}`;
    const tree = checkout(dir, key, 'paging', 'mvpfy/paging');
    fs.writeFileSync(path.join(tree, 'paging.ts'), 'feature\n');
    git(tree, 'add', '-A');
    git(tree, 'commit', '-m', 'feature');
    expect(pushFeatureBranchCommand([dir], 'mvpfy/paging')).toBe('');
  }, 60_000);

  it('refuses to push from a directory outside a managed or linked workspace', () => {
    setLinkedRoots([]);
    expect(() => pushFeatureBranchCommand(['/etc'], 'mvpfy/paging')).toThrow(
      /restricted to managed and linked/
    );
  });
  it('pushes every other repository when one of them fails', () => {
    // The reported failure: repositories were joined with && , so the first
    // one git refused took the rest of them down with it and their commits
    // never reached the remote at all.
    const a = work();
    const b = work();
    setLinkedRoots([a.dir, b.dir]);
    const key = `test-${path.basename(a.dir)}`;
    for (const r of [a, b]) {
      const tree = checkout(r.dir, key, 'paging', 'mvpfy/paging');
      fs.writeFileSync(path.join(tree, 'paging.ts'), 'feature\n');
      git(tree, 'add', '-A');
      git(tree, 'commit', '-m', 'feature');
      git(tree, 'push', '-u', 'origin', 'mvpfy/paging');
      fs.writeFileSync(path.join(tree, 'paging.ts'), 'more\n');
      git(tree, 'add', '-A');
      git(tree, 'commit', '-m', 'more');
    }
    // The first repository's remote is gone, so its push cannot work.
    fs.rmSync(a.origin, { recursive: true, force: true });

    const cmd = pushFeatureBranchCommand([a.dir, b.dir], 'mvpfy/paging');
    expect(spawnShellSync(cmd, { encoding: 'utf8', timeout: 60_000 }).status).toBe(0);

    // The one that could be pushed was pushed, and said so; the one that could
    // not says why in its own words rather than silently taking the rest with it.
    expect(rev(b.origin, 'mvpfy/paging')).toBe(rev(b.dir, 'mvpfy/paging'));
    expect(pushFeatureBranchCommand([b.dir], 'mvpfy/paging')).toBe('');
    expect(cmd).toContain('would not take this push');
  }, 120_000);

  it('merges every other repository when one of them conflicts', () => {
    const a = work();
    const b = work();
    setLinkedRoots([a.dir, b.dir]);
    const key = `test-${path.basename(a.dir)}`;
    const treeA = checkout(a.dir, key, 'paging', 'mvpfy/paging');
    const treeB = checkout(b.dir, key, 'paging', 'mvpfy/paging');
    // The first conflicts with its trunk; the second has nothing in the way.
    fs.writeFileSync(path.join(treeA, 'index.ts'), 'feature\n');
    git(treeA, 'add', '-A');
    git(treeA, 'commit', '-m', 'feature');
    landOnTrunk(a.origin, 'index.ts', 'trunk\n');
    landOnTrunk(b.origin, 'pricing.ts', 'landed\n');

    const cmd = mergeTrunkCommand(key, 'paging', [a.dir, b.dir], 'mvpfy/paging', 'keep');
    expect(spawnShellSync(cmd, { encoding: 'utf8', timeout: 60_000 }).status).toBe(0);

    // The conflict is left open where it happened, and the repository behind
    // it is up to date rather than untouched.
    expect(featureConflicts([a.dir, b.dir], key, 'paging').map((c) => c.repo)).toEqual([a.dir]);
    expect(fs.existsSync(path.join(treeB, 'pricing.ts'))).toBe(true);
    const [, rowB] = featureGitStatus([a.dir, b.dir], key, 'paging', 'mvpfy/paging');
    expect(rowB.behind).toBe(0);
  }, 120_000);
});
