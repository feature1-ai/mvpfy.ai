import { describe, expect, it } from 'vitest';
import { mcpBaseUrl, mcpHost, tenantSlugFrom, tokenKeychainEntry } from './feature1Mcp';

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
