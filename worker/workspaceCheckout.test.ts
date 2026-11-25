import { describe, expect, it } from 'vitest';
import { checkOutWorkspace, repositoryFolders, workspaceDir } from './workspaceCheckout';

const repo = (id: string, name: string, base = 'main') => ({
  id: `${id}0000000-0000-4000-8000-000000000000`.slice(0, 36),
  name,
  url: `https://github.com/acme/${name}.git`,
  base_branch: base,
});
const api = repo('aaaaaaaa', 'api');
const web = repo('bbbbbbbb', 'web', 'develop');
const otherApi = repo('cccccccc', 'api');

describe("a product's repositories, side by side", () => {
  it('keeps a single repository as the root, as before', () => {
    expect(workspaceDir('/w/previews/p1', [api])).toBe(`/w/previews/p1/${api.id}`);
    expect(workspaceDir('/w/previews/p1', [api, web])).toBe('/w/previews/p1/workspace');
  });

  it('names each folder after its repository, and two of the same name apart', () => {
    expect([...repositoryFolders([api, web, otherApi]).values()]).toEqual([
      'api',
      'web',
      'api-cccccccc',
    ]);
  });

  it('checks each out at the branch chosen for it, and says what each is at', async () => {
    const calls: string[] = [];
    const git = {
      detachedCheckout: async (_t: string, r: { name: string }, branch: string, dir: string) => {
        calls.push(`${r.name}@${branch} → ${dir}`);
        return `${r.name}-sha`;
      },
    };
    const built = new Set([api.id]);
    const out = await checkOutWorkspace(git, 't', [api, web], '/w/previews/p1', (r) =>
      built.has(r.id) ? 'mvpfy/x' : r.base_branch
    );
    expect(calls).toEqual([
      'api@mvpfy/x → /w/previews/p1/workspace/api',
      'web@develop → /w/previews/p1/workspace/web',
    ]);
    expect(out).toEqual({
      dir: '/w/previews/p1/workspace',
      commits: {
        api: { branch: 'mvpfy/x', commit: 'api-sha' },
        web: { branch: 'develop', commit: 'web-sha' },
      },
    });
  });
});
