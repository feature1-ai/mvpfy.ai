import { describe, expect, it } from 'vitest';
import { loginCommand, loginOpensTerminal, mcpAddCommand, parseModelsFromHelp } from './cli';
import { shellQuote } from './shell';

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

describe('parseModelsFromHelp', () => {
  // Claude Code's real --help, which names the aliases in prose.
  const claudeHelp = [
    '  --mcp-config <configs...>             Load MCP servers from JSON',
    '  --model <model>                       Model for the current session. Provide',
    '                                        an alias for the latest model (e.g.',
    "                                        'fable', 'opus', or 'sonnet') or a",
    "                                        model's full name (e.g.",
    "                                        'claude-fable-5').",
    '  -n, --name <name>                     Set a display name for this session',
  ].join('\n');

  it('reads the models the CLI advertises, in order, without duplicates', () => {
    expect(parseModelsFromHelp(claudeHelp)).toEqual(['fable', 'opus', 'sonnet', 'claude-fable-5']);
  });

  it('stops at the next option, so a later quoted word is not a model', () => {
    const help = `${claudeHelp}\n  --output-format <format>              choices: 'text', 'stream-json'`;
    expect(parseModelsFromHelp(help)).not.toContain('text');
    expect(parseModelsFromHelp(help)).not.toContain('stream-json');
  });

  it('handles a short flag before the long one, as codex writes it', () => {
    const help = "  -m, --model <MODEL>\n          Use 'o3' or 'gpt-5'\n\n      --oss";
    expect(parseModelsFromHelp(help)).toEqual(['o3', 'gpt-5']);
  });

  it('returns nothing when the CLI names no models, so the user can type one', () => {
    expect(
      parseModelsFromHelp('  -m, --model <MODEL>\n          Model the agent should use')
    ).toEqual([]);
    expect(parseModelsFromHelp('no options here at all')).toEqual([]);
    expect(parseModelsFromHelp('')).toEqual([]);
  });
});

describe('mcpAddCommand', () => {
  const command = mcpAddCommand('feature1', 'https://warsha-mcp.feature1.ai/mcp/');

  it('registers at user scope, so no repository gains an .mcp.json', () => {
    expect(command).toContain('-s user');
    expect(command).toContain('claude mcp add --transport http');
    expect(command).toContain(shellQuote('https://warsha-mcp.feature1.ai/mcp/'));
  });

  it('removes any earlier registration first, and does so unconditionally', () => {
    // `add` refuses a name already taken, and connecting to a second workspace
    // has to replace the first. Not registered is the wanted state either way,
    // so a failing remove must not stop the add.
    const removeAt = command.indexOf('mcp remove');
    const addAt = command.indexOf('mcp add');
    expect(removeAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(removeAt);
    expect(command.slice(removeAt, addAt)).not.toContain('&&');
  });
});
