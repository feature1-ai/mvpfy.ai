import { describe, expect, it } from 'vitest';
import { hostFromDemoLogin } from './shareHost';

const login = (...pairs: Array<[string, string]>) => [
  { label: 'App login', fields: pairs.map(([key, value]) => ({ key, value })) },
];

describe('hostFromDemoLogin', () => {
  it('takes the tenant address the seed recorded', () => {
    expect(
      hostFromDemoLogin(login(['url', 'http://acme.localhost:4100'], ['email', 'demo@acme.test']))
    ).toBe('acme.localhost:4100');
  });

  it('says nothing for a plain localhost, which would make sharing worse', () => {
    // Forcing the host to localhost makes an app that builds absolute URLs
    // from it hand the visitor localhost links. Left alone it sees the
    // tunnel's address and builds links that work from another machine.
    expect(hostFromDemoLogin(login(['url', 'http://localhost:4100']))).toBe('');
    expect(hostFromDemoLogin(login(['url', 'http://127.0.0.1:4100']))).toBe('');
  });

  it('reads an address written without a scheme', () => {
    expect(hostFromDemoLogin(login(['app_url', 'acme.localhost:4100/login']))).toBe(
      'acme.localhost:4100'
    );
  });

  it('ignores the fields that are not an address', () => {
    expect(hostFromDemoLogin(login(['email', 'demo@acme.test'], ['otp', '123456']))).toBe('');
  });

  it('says nothing rather than guessing at something unparseable', () => {
    expect(hostFromDemoLogin(login(['url', 'not a url at all']))).toBe('');
    expect(hostFromDemoLogin([])).toBe('');
  });
});
