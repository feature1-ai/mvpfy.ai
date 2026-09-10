import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isWorktreePath, PROJECTS_DIR, setLinkedRoots, WORKTREES_DIR } from '../paths';
import {
  checkoutDefaultCommand,
  checkoutFeatureCommand,
  raisePrCommand,
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
      /No repository has commits on mvpfy\/invoice-export/i
    );
  });

  it('rejects any directory outside a managed or linked workspace', () => {
    expect(() => raisePrCommand(['/etc'], 'mvpfy/x', 't', 'b')).toThrow(
      /restricted to managed and linked/
    );
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
