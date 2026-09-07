import { describe, expect, it } from 'vitest';
import { REQUIRED_CLIS } from '../../shared/types';
import { CLI_HELP, installHintFor } from './cliCheck';

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
