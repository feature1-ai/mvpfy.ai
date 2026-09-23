import { describe, expect, it } from 'vitest';
import { tunnelCommand } from './share';

describe('tunnelCommand', () => {
  it('points the tunnel at the app and never updates mid-share', () => {
    // An update restarts cloudflared and changes the address, which is a link
    // going dead in somebody else's browser.
    const cmd = tunnelCommand(4100);
    expect(cmd).toContain("--url 'http://localhost:4100'");
    expect(cmd).toContain('--no-autoupdate');
  });

  it('tells the app which host it was asked for, for a product with tenants', () => {
    // A share arrives as four random words. An app that reads its tenant out
    // of the hostname finds none and shows the visitor nothing.
    expect(tunnelCommand(4100, 'acme.localhost:4100')).toContain(
      "--http-host-header 'acme.localhost:4100'"
    );
  });

  it('says nothing about a host when there is none to say', () => {
    expect(tunnelCommand(4100)).not.toContain('--http-host-header');
    expect(tunnelCommand(4100, '   ')).not.toContain('--http-host-header');
  });

  it('refuses a host that is not one, before it reaches a command line', () => {
    expect(() => tunnelCommand(4100, 'acme.localhost && rm -rf /')).toThrow(/not a hostname/);
    expect(() => tunnelCommand(4100, 'http://acme.localhost')).toThrow(/not a hostname/);
  });

  it('refuses a port that is not one', () => {
    expect(() => tunnelCommand(0)).toThrow(/not a port/);
    expect(() => tunnelCommand(70000)).toThrow(/not a port/);
  });
});
