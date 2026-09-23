import { afterEach, describe, expect, it } from 'vitest';
import {
  Feature1McpClient,
  mcpBaseUrl,
  mcpHost,
  tenantSlugFrom,
  tokenKeychainEntry,
} from './feature1Mcp';

describe('tenantSlugFrom', () => {
  it('accepts the address the user actually has in their browser', () => {
    expect(tenantSlugFrom('https://acme.feature1.ai/stories')).toBe('acme');
    expect(tenantSlugFrom('https://acme.feature1.ai')).toBe('acme');
    expect(tenantSlugFrom('acme.feature1.ai')).toBe('acme');
    expect(tenantSlugFrom('http://acme.feature1.ai/')).toBe('acme');
  });

  it('accepts the MCP endpoint, dropping the -mcp host suffix', () => {
    expect(tenantSlugFrom('https://acme-mcp.feature1.ai/mcp/')).toBe('acme');
    expect(tenantSlugFrom('acme-mcp.feature1.ai')).toBe('acme');
  });

  it('still accepts a bare slug', () => {
    expect(tenantSlugFrom('acme')).toBe('acme');
    expect(tenantSlugFrom('  ACME  ')).toBe('acme');
    expect(tenantSlugFrom('big-co')).toBe('big-co');
  });

  it('keeps a hyphenated slug that merely ends in something else', () => {
    expect(tenantSlugFrom('acme-mcpx.feature1.ai')).toBe('acme-mcpx');
  });

  it('tolerates ports, paths, query strings and a trailing dot', () => {
    expect(tenantSlugFrom('https://acme.feature1.ai:443/a/b?c=d#e')).toBe('acme');
    expect(tenantSlugFrom('acme.feature1.ai.')).toBe('acme');
  });

  it('returns null when there is no usable slug', () => {
    expect(tenantSlugFrom('')).toBeNull();
    expect(tenantSlugFrom('   ')).toBeNull();
    expect(tenantSlugFrom('https://')).toBeNull();
    expect(tenantSlugFrom('-acme')).toBeNull();
    expect(tenantSlugFrom('ac me')).toBeNull();
  });

  it('feeds the URLs the client builds', () => {
    const slug = tenantSlugFrom('https://acme.feature1.ai/stories')!;
    expect(mcpHost(slug)).toBe('acme-mcp.feature1.ai');
    expect(mcpBaseUrl(slug)).toBe('https://acme-mcp.feature1.ai/mcp/');
    expect(tokenKeychainEntry(slug)).toBe('feature1-mcp-acme');
  });
});

describe('listAssignedFeatures', () => {
  const reply = (result: unknown) => {
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async (req: { url: string }) => ({
          ok: true,
          status: 200,
          body: JSON.stringify(
            req.url.endsWith('/api/auth/me')
              ? { tenant: { id: 'tenant-acme', slug: 'acme' }, user: { id: 'user-acme' } }
              : { jsonrpc: '2.0', id: 1, result }
          ),
        }),
      },
    };
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reads the structured payload, not the Markdown written for agents', async () => {
    reply({
      structuredContent: {
        features: [
          {
            id: 'uuid-1',
            code: 'FEA-142',
            title: 'Invoice PDF export',
            status: 'in_progress',
            story_count: 4,
            project_name: 'billing',
          },
        ],
        total: 1,
      },
      content: [{ type: 'text', text: '# Features (1 found)\n## Invoice PDF export' }],
    });
    const features = await new Feature1McpClient('acme', 't').listAssignedFeatures();
    expect(features).toEqual([
      {
        id: 'uuid-1',
        code: 'FEA-142',
        title: 'Invoice PDF export',
        status: 'in_progress',
        priority: undefined,
        description: undefined,
        projectName: 'billing',
        storyCount: 4,
        updatedAt: undefined,
      },
    ]);
  });

  it('drops a feature with no code, which could never be pulled', async () => {
    reply({
      structuredContent: {
        features: [
          { id: 'a', code: '', title: 'No code', status: 'draft' },
          { id: 'b', code: 'FEA-9', title: 'Fine', status: 'draft' },
        ],
      },
    });
    const features = await new Feature1McpClient('acme', 't').listAssignedFeatures();
    expect(features.map((f) => f.code)).toEqual(['FEA-9']);
  });

  it('survives the optional fields being absent', async () => {
    reply({
      structuredContent: {
        features: [{ id: 'a', code: 'FEA-1', title: 'Bare', status: 'draft' }],
      },
    });
    const [feature] = await new Feature1McpClient('acme', 't').listAssignedFeatures();
    expect(feature.storyCount).toBeUndefined();
    expect(feature.projectName).toBeUndefined();
  });

  it('says so plainly when the workspace has no assigned-feature support', async () => {
    // An older server answers with prose only, and no structuredContent.
    reply({ content: [{ type: 'text', text: '# Features (3 found)' }] });
    await expect(new Feature1McpClient('acme', 't').listAssignedFeatures()).rejects.toThrow(
      /without assigned-feature support/
    );
  });
});

describe('browserLogin', () => {
  const reply = (result: unknown) => {
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async (req: { url: string }) => ({
          ok: true,
          status: 200,
          body: JSON.stringify(
            req.url.endsWith('/api/auth/me')
              ? { tenant: { id: 'tenant-acme', slug: 'acme' }, user: { id: 'user-acme' } }
              : { jsonrpc: '2.0', id: 1, result }
          ),
        }),
      },
    };
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reads a login handed back beside the prose, not only inside it', async () => {
    // The tool's answer lives in fields next to `content`; the text block is
    // instructions for a human and is not JSON.
    reply({
      content: [
        { type: 'text', text: 'Open this URL to sign in:\n\nhttps://acme-mcp.feature1.ai/login' },
      ],
      loginUrl: 'https://acme-mcp.feature1.ai/login',
      loginId: 'abc123',
    });
    expect(await new Feature1McpClient('acme', null).browserLogin()).toEqual({
      loginUrl: 'https://acme-mcp.feature1.ai/login',
      loginId: 'abc123',
    });
  });

  it('accepts snake_case too', async () => {
    reply({ content: [], login_url: 'https://acme-mcp.feature1.ai/login', login_id: 'abc123' });
    const start = await new Feature1McpClient('acme', null).browserLogin();
    expect(start.loginId).toBe('abc123');
  });

  it('can open a browser without treating it as an authenticated connection', async () => {
    // A sign-in URL is only an instruction; it does not authenticate this client.
    reply({
      content: [{ type: 'text', text: 'Open https://acme-mcp.feature1.ai/login' }],
      loginUrl: 'https://acme-mcp.feature1.ai/login',
    });
    expect(await new Feature1McpClient('acme', null).browserLogin()).toEqual({
      loginUrl: 'https://acme-mcp.feature1.ai/login',
      loginId: null,
    });
  });

  it('says so plainly when there is no sign-in URL at all', async () => {
    reply({ content: [{ type: 'text', text: 'nope' }] });
    await expect(new Feature1McpClient('acme', null).browserLogin()).rejects.toThrow(
      /did not offer a sign-in URL/
    );
  });
});

describe('tenant isolation', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });
  it('never lists features without a personal bearer token', async () => {
    let called = false;
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async () => {
          called = true;
          throw new Error('Must not fetch');
        },
      },
    };
    await expect(new Feature1McpClient('watiq', null).listAssignedFeatures()).rejects.toThrow(
      /own token/
    );
    expect(called).toBe(false);
  });
  it('rejects a Satorixr token on Watiq before calling the feature tool', async () => {
    const urls: string[] = [];
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async (req: { url: string }) => {
          urls.push(req.url);
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              tenant: { id: 'satorixr', slug: 'satorixr' },
              user: { id: 'u' },
            }),
          };
        },
      },
    };
    await expect(
      new Feature1McpClient('watiq', 'wrong-token').listAssignedFeatures()
    ).rejects.toThrow(/different workspace/);
    expect(urls).toEqual(['https://watiq.feature1.ai/api/auth/me']);
  });
  it('sends the same personal credential to identity verification and feature listing', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async (req: { url: string; headers: Record<string, string> }) => {
          requests.push(req);
          return {
            ok: true,
            status: 200,
            body: JSON.stringify(
              req.url.endsWith('/auth/me')
                ? { tenant: { id: 'watiq', slug: 'watiq' }, user: { id: 'u' } }
                : { result: { structuredContent: { features: [] } } }
            ),
          };
        },
      },
    };
    await expect(
      new Feature1McpClient('watiq', 'personal').listAssignedFeatures()
    ).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.headers.Authorization === 'Bearer personal')).toBe(true);
  });
  it('does not trust a legacy authenticated flag as an identity', async () => {
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async () => ({
          ok: true,
          status: 200,
          body: JSON.stringify({ authenticated: true }),
        }),
      },
    };
    await expect(new Feature1McpClient('watiq', 't').verifyIdentity()).rejects.toThrow(
      /verified identity/
    );
  });
  it('rejects tool errors even when accompanied by structured data', async () => {
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async (req: { url: string }) => ({
          ok: true,
          status: 200,
          body: JSON.stringify(
            req.url.endsWith('/auth/me')
              ? { tenant: { id: 'watiq', slug: 'watiq' }, user: { id: 'u' } }
              : {
                  result: {
                    isError: true,
                    content: [{ type: 'text', text: 'Access denied' }],
                    structuredContent: { features: [] },
                  },
                }
          ),
        }),
      },
    };
    await expect(new Feature1McpClient('watiq', 't').listAssignedFeatures()).rejects.toThrow(
      'Access denied'
    );
  });
  it('will not open a browser login on another workspace', async () => {
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        mcpFetch: async () => ({
          ok: true,
          status: 200,
          body: JSON.stringify({ result: { loginUrl: 'https://satorixr-mcp.feature1.ai/login' } }),
        }),
      },
    };
    await expect(new Feature1McpClient('watiq', null).browserLogin()).rejects.toThrow(
      /different workspace/
    );
  });
});
