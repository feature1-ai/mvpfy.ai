import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECTS_DIR, setLinkedRoots } from '../paths';
import { repoSyncCommand } from './projects';
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
