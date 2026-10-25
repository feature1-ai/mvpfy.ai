import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROJECTS_DIR,
  WORKTREES_DIR,
  isAllowedWorkspace,
  isLinkedPath,
  isManagedPath,
  isWorktreePath,
  setLinkedRoots,
} from './paths';

describe('isManagedPath', () => {
  it('accepts paths inside the managed projects directory', () => {
    expect(isManagedPath(path.join(PROJECTS_DIR, 'my-app'))).toBe(true);
    expect(isManagedPath(path.join(PROJECTS_DIR, 'stack', 'backend'))).toBe(true);
  });

  it('rejects the projects directory itself', () => {
    expect(isManagedPath(PROJECTS_DIR)).toBe(false);
  });

  it('rejects paths outside the projects directory', () => {
    expect(isManagedPath('/etc')).toBe(false);
    expect(isManagedPath(path.dirname(PROJECTS_DIR))).toBe(false);
  });

  it('rejects sibling directories that share the prefix as a string', () => {
    expect(isManagedPath(PROJECTS_DIR + '-evil/app')).toBe(false);
  });

  it('resolves traversal before checking', () => {
    expect(isManagedPath(path.join(PROJECTS_DIR, 'app', '..', '..', '..', 'etc'))).toBe(false);
    expect(isManagedPath(path.join(PROJECTS_DIR, 'app', '..', 'other'))).toBe(true);
  });
});

describe('linked roots', () => {
  beforeEach(() => setLinkedRoots([]));

  it('allows exactly the registered roots and their contents', () => {
    setLinkedRoots(['/Users/pm/code/shop']);
    expect(isLinkedPath('/Users/pm/code/shop')).toBe(true);
    expect(isLinkedPath('/Users/pm/code/shop/api')).toBe(true);
    expect(isLinkedPath('/Users/pm/code/shop-evil')).toBe(false);
    expect(isLinkedPath('/Users/pm/code')).toBe(false);
  });

  it('allows nothing when no roots are registered', () => {
    expect(isLinkedPath('/Users/pm/code/shop')).toBe(false);
  });
});

describe('isAllowedWorkspace', () => {
  beforeEach(() => setLinkedRoots([]));

  it('accepts managed clones and linked roots, nothing else', () => {
    setLinkedRoots(['/Users/pm/code/shop']);
    expect(isAllowedWorkspace(path.join(PROJECTS_DIR, 'my-app'))).toBe(true);
    expect(isAllowedWorkspace('/Users/pm/code/shop/api')).toBe(true);
    expect(isAllowedWorkspace('/Users/pm/code/other')).toBe(false);
    expect(isAllowedWorkspace('/')).toBe(false);
  });
});

describe('what a terminal may be opened in', () => {
  // The handler admits a project directory or a feature's checkout, and the
  // second was added so "Terminal" beside a worktree path does something.
  // Worth stating as a test, because widening a guard is the kind of change
  // that quietly widens further.
  const admitted = (candidate: string) =>
    isAllowedWorkspace(candidate) || isWorktreePath(candidate);

  it('admits a feature checkout, which is a directory mvpfy made', () => {
    expect(admitted(path.join(WORKTREES_DIR, 'shop-a1b2c3', 'invoice-export', 'api'))).toBe(true);
  });

  it('still admits a managed project', () => {
    expect(admitted(path.join(PROJECTS_DIR, 'shop'))).toBe(true);
  });

  it('does not admit the worktrees directory itself', () => {
    expect(admitted(WORKTREES_DIR)).toBe(false);
  });

  it('does not admit anywhere else, which is the whole point of the guard', () => {
    for (const elsewhere of ['/etc', '/Users/pm/Documents', `${WORKTREES_DIR}-next-door`]) {
      expect(admitted(elsewhere), elsewhere).toBe(false);
    }
  });
});
