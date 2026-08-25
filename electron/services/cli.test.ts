import { describe, expect, it } from 'vitest';
import { loginCommand } from './cli';

describe('loginCommand', () => {
  it('knows the in-app sign-in command for gh and codex', () => {
    expect(loginCommand('gh')).toBe(
      'gh auth login --hostname github.com --git-protocol https --web'
    );
    expect(loginCommand('codex')).toBe('codex login');
  });

  it('refuses tools without an in-app sign-in flow', () => {
    expect(() => loginCommand('claude')).toThrow('No in-app sign-in for "claude"');
    expect(() => loginCommand('rm -rf /')).toThrow(/No in-app sign-in/);
  });
});
