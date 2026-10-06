import { describe, expect, it } from 'vitest';
import { parseTenancy, tenancyLine, tenancyNeedsAnswer, validTenant } from './tenancy';

const file = (tenancy: unknown) => JSON.stringify({ tenancy });

describe('parseTenancy', () => {
  it('reads how the product picks a customer', () => {
    expect(parseTenancy(file({ mode: 'host', local: 'demo.localhost' }))).toEqual({
      mode: 'host',
      local: 'demo.localhost',
    });
    expect(parseTenancy(file({ mode: 'header', local: 'demo', header: 'X-Workspace' }))).toEqual({
      mode: 'header',
      local: 'demo',
      header: 'X-Workspace',
    });
  });

  it('is nothing rather than a guess when the file says nothing usable', () => {
    expect(parseTenancy(null)).toBeNull();
    expect(parseTenancy('not json')).toBeNull();
    expect(parseTenancy('{}')).toBeNull();
    expect(parseTenancy(file({ mode: 'subdomain' }))).toBeNull();
  });
});

describe('validTenant', () => {
  it('accepts what can go in a hostname, a header and a compose file', () => {
    expect(validTenant('acme')).toBe(true);
    expect(validTenant('demo.localhost')).toBe(true);
    expect(validTenant('acme-eu_2')).toBe(true);
  });

  it('refuses anything that is a mistake rather than a tenant', () => {
    // This is written into generated configuration and sent to a real server.
    expect(validTenant('acme corp')).toBe(false);
    expect(validTenant('acme;rm -rf /')).toBe(false);
    expect(validTenant('$(whoami)')).toBe(false);
    expect(validTenant('-leading-dash')).toBe(false);
    expect(validTenant('')).toBe(false);
    expect(validTenant(null)).toBe(false);
  });
});

describe('tenancyNeedsAnswer', () => {
  it('asks when the product has customers and nothing says which to be', () => {
    expect(tenancyNeedsAnswer(parseTenancy(file({ mode: 'host', local: '' })))).toBe(true);
  });

  it('does not ask about a product that has no tenants', () => {
    expect(tenancyNeedsAnswer(parseTenancy(file({ mode: 'none', local: '' })))).toBe(false);
    expect(tenancyNeedsAnswer(null)).toBe(false);
  });

  it('stops once there is a usable answer', () => {
    expect(tenancyNeedsAnswer(parseTenancy(file({ mode: 'path', local: 'acme' })))).toBe(false);
  });
});

describe('tenancyLine', () => {
  it('says where the customer comes from and who this app is', () => {
    expect(tenancyLine(parseTenancy(file({ mode: 'host', local: 'demo.localhost' })))).toBe(
      'Your product reads the customer in the web address. Here it runs as demo.localhost.'
    );
    expect(tenancyLine(parseTenancy(file({ mode: 'header', local: '', header: 'X-Org' })))).toMatch(
      /in the X-Org header, and nothing says which one to be here/
    );
  });

  it('says nothing at all about a product with one customer', () => {
    expect(tenancyLine(parseTenancy(file({ mode: 'none', local: '' })))).toBe('');
  });
});
