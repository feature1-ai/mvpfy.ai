import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isWorktreePath, PROJECTS_DIR, setLinkedRoots, WORKTREES_DIR } from '../paths';
import {
  checkoutDefaultCommand,
  ensureInitialCommit,
  checkoutFeatureCommand,
  featureCheckedOut,
  raisePrCommand,
  workspaceIsEmpty,
  repoSyncCommand,
  worktreeAddCommand,
  worktreePathFor,
  worktreeRemoveCommand,
} from './projects';
import { IS_WIN, shellQuote } from './shell';

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
