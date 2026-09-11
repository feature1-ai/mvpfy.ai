import { afterEach, describe, expect, it } from 'vitest';
import { CliName, CliStatus, REQUIRED_CLIS } from '../../shared/types';
import { CLI_HELP, installHintFor, preflightAuth } from './cliCheck';

describe('installHintFor', () => {
  it('gives every required tool an install command on every OS', () => {
    for (const name of REQUIRED_CLIS) {
      for (const os of ['mac', 'windows', 'linux'] as const) {
        expect(installHintFor(name, os), `${name} on ${os}`).toBeTruthy();
      }
    }
  });

  it('never tells a Windows user to run a shell script through bash', () => {
    for (const name of REQUIRED_CLIS) {
      const hint = installHintFor(name, 'windows');
      expect(hint, name).not.toMatch(/\|\s*(bash|sh)\b/);
      expect(hint, name).not.toMatch(/\b(brew|xcode-select|sudo apt)\b/);
    }
  });

  it('keeps the macOS hints, which is the primary platform', () => {
    expect(installHintFor('claude', 'mac')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installHintFor('gh', 'mac')).toBe('brew install gh');
  });

  it('points every tool at a docs page', () => {
    for (const name of REQUIRED_CLIS) {
      expect(CLI_HELP[name].installUrl, name).toMatch(/^https:\/\//);
    }
  });
});

describe('preflightAuth', () => {
  const stub = (statuses: CliStatus[]) => {
    (globalThis as { window?: unknown }).window = { mvpfy: { cliCheck: async () => statuses } };
  };
  const cli = (name: CliName, found: boolean, authenticated: boolean | null): CliStatus => ({
    name,
    found,
    path: found ? `/usr/bin/${name}` : null,
    authenticated,
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('catches a missing GitHub sign-in before anything is pushed', async () => {
    // Raising a pull request without one fails several steps in, which read
    // as the button doing nothing at all.
    stub([cli('gh', true, false)]);
    expect(await preflightAuth(null, true)).toMatch(/GitHub CLI is not signed in/);
  });

  it('asks nothing of the agent for work that runs no agent', async () => {
    stub([cli('gh', true, true), cli('claude', true, false)]);
    expect(await preflightAuth(null, true)).toBeNull();
  });

  it('still checks the agent when one is named', async () => {
    stub([cli('gh', true, true), cli('claude', true, false)]);
    expect(await preflightAuth('claude', true)).toMatch(/Claude Code is not signed in/);
  });

  it('reports a tool that is not installed at all', async () => {
    stub([cli('gh', false, null)]);
    expect(await preflightAuth(null, true)).toMatch(/GitHub CLI was not found/);
  });
});
