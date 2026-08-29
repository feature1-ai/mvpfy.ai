import { describe, expect, it } from 'vitest';
import { installCommand, installPlans, terminalCommand } from './install';

const onMac = process.platform === 'darwin';

describe('terminalCommand', () => {
  it('wraps the command in an AppleScript that opens Terminal', () => {
    const out = terminalCommand('brew install gh');
    expect(out).toContain('osascript');
    expect(out).toContain('tell application "Terminal" to activate');
    expect(out).toContain('do script "brew install gh"');
  });

  it('escapes quotes and backslashes so the AppleScript literal survives', () => {
    // The Homebrew installer's own line is full of quotes — the exact case
    // this has to get right.
    const out = terminalCommand('/bin/bash -c "$(curl -fsSL https://example.com/i.sh)"');
    expect(out).toContain('\\"$(curl');
    const back = terminalCommand('a\\b');
    expect(back).toContain('a\\\\b');
  });
});

describe.skipIf(!onMac)('installPlans (macOS)', () => {
  const plans = installPlans();
  const plan = (tool: string) => plans.find((p) => p.tool === tool);

  it('names the missing prerequisite in the note, for the row to show', () => {
    for (const p of plans.filter((x) => !x.available && x.tool !== 'brew')) {
      expect(p.note).toMatch(/needs (Homebrew|Node)/);
    }
  });

  it('covers every required tool plus Homebrew', () => {
    expect(plans.map((p) => p.tool).sort()).toEqual(
      ['brew', 'claude', 'codex', 'docker', 'gh', 'git'].sort()
    );
    for (const p of plans) {
      expect(p.command.trim()).not.toBe('');
      expect(p.note.trim()).not.toBe('');
    }
  });

  it('hands the password-prompting installs to Terminal', () => {
    expect(plan('brew')?.mode).toBe('terminal');
    expect(plan('git')?.mode).toBe('terminal');
    expect(plan('git')?.command).toBe('xcode-select --install');
  });

  it('installs Claude Code without Homebrew, Node or a password', () => {
    const claude = plan('claude');
    expect(claude).toMatchObject({ mode: 'in-app', available: true });
    expect(claude?.command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });

  it('uses the current Docker Desktop cask token', () => {
    expect(plan('docker')?.command).toBe('brew install --cask docker-desktop');
  });

  it('routes a terminal-mode install through osascript', () => {
    expect(installCommand('git')).toContain('osascript');
    expect(installCommand('git')).toContain('xcode-select --install');
  });

  it('refuses a tool it has no installer for', () => {
    expect(() => installCommand('kubectl')).toThrow(/No installer/);
  });
});
