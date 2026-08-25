import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isAllowedWorkspace,
  isLinkedPath,
  isManagedPath,
  PROJECTS_DIR,
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
