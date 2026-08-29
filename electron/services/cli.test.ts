import { describe, expect, it } from 'vitest';
import { loginCommand, loginOpensTerminal } from './cli';

const onMac = process.platform === 'darwin';

describe('loginCommand', () => {
  it('signs gh in and wires git in the same step', () => {
    // Without setup-git, gh is signed in but `git push` still fails later —
    // inside an agent run, where the PM cannot see why.
    expect(loginCommand('gh')).toBe(
      'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git'
    );
  });

  it('knows the in-app sign-in command for codex', () => {
    expect(loginCommand('codex')).toBe('codex login');
    expect(loginOpensTerminal('codex')).toBe(false);
  });

  it('sends the Claude sign-in to Terminal, where it can be interactive', () => {
    expect(loginOpensTerminal('claude')).toBe(true);
    if (onMac) {
      const command = loginCommand('claude');
      expect(command).toContain('osascript');
      expect(command).toContain('claude auth login');
    } else {
      expect(() => loginCommand('claude')).toThrow(/Run "claude auth login" in a terminal/);
    }
  });

  it('refuses tools without a sign-in flow', () => {
    expect(() => loginCommand('git')).toThrow('No in-app sign-in for "git"');
    expect(() => loginCommand('rm -rf /')).toThrow(/No in-app sign-in/);
    expect(loginOpensTerminal('git')).toBe(false);
  });
});
