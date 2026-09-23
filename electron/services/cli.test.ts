import { describe, expect, it } from 'vitest';
import {
  loginCommand,
  loginOpensTerminal,
  mcpAddCommand,
  parseCodexModels,
  parseModelsFromHelp,
  signInAllCommand,
  signInNeedsOwnWindow,
} from './cli';
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
  it('registers Codex without requiring Claude', () => {
    expect(mcpAddCommand('feature1', 'https://example.com/mcp', 'codex')).toBe(
      `codex mcp add ${shellQuote('feature1')} --url ${shellQuote('https://example.com/mcp')}`
    );
  });
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

describe('signInAllCommand', () => {
  it('runs the sign-ins one after another, never in parallel', () => {
    // Each prints a device code or opens a browser and waits. Two at once puts
    // two codes in one log with no way to tell which belongs to which.
    const cmd = signInAllCommand(['gh', 'codex']);
    expect(cmd.indexOf('gh auth login')).toBeLessThan(cmd.indexOf('codex login'));
    // The join between the two tools is "then, regardless" — gh's own command
    // uses && internally to chain setup-git onto its sign-in, which is a
    // different thing and must survive.
    const between = cmd.slice(cmd.indexOf('setup-git'), cmd.indexOf('codex login'));
    expect(between).not.toContain('&&');
  });

  it('announces each one, so a log of two sign-ins can be read', () => {
    expect(signInAllCommand(['gh'])).toMatch(/echo .*signing in to gh/);
  });

  it('still wires git credentials, which gh being signed in does not do', () => {
    // The failure this whole path exists for: gh reports itself signed in and
    // the push fails on credentials anyway.
    expect(signInAllCommand(['gh'])).toContain('gh auth setup-git');
  });

  it('leaves out a sign-in that needs its own window, and says so', () => {
    expect(() => signInAllCommand(['claude'])).toThrow(/own window/i);
    expect(signInNeedsOwnWindow(['claude', 'gh'])).toEqual(['claude']);
  });

  it('refuses a tool with no sign-in at all', () => {
    expect(() => signInAllCommand(['docker'])).toThrow(/own window/i);
  });
});

describe('parseCodexModels', () => {
  it('reads the model codex is configured with', () => {
    // The only list codex can honestly offer: what this person actually uses.
    // There is no `codex models`, and --model takes any string, so its help
    // has nothing to read the way Claude's does.
    expect(parseCodexModels('model = "gpt-6-astra"\n')).toEqual(['gpt-6-astra']);
  });

  it('collects models from profiles and pinned projects too, without repeats', () => {
    const toml = [
      'model = "gpt-6-astra"',
      '',
      '[profiles.fast]',
      "model = 'o4-mini'",
      '',
      '[projects."/Users/pm/app"]',
      'model = "gpt-6-astra"',
    ].join('\n');
    expect(parseCodexModels(toml)).toEqual(['gpt-6-astra', 'o4-mini']);
  });

  it('does not mistake other model_ keys for a model', () => {
    // model_provider names the provider, not a model — offering "openai" in
    // the picker would produce a run that fails at the first request.
    expect(parseCodexModels('model_provider = "openai"\nmodel_reasoning = "high"\n')).toEqual([]);
  });

  it('says nothing rather than guessing when there is no config', () => {
    expect(parseCodexModels('')).toEqual([]);
    expect(parseCodexModels('[projects."/Users/pm/app"]\ntrust_level = "trusted"\n')).toEqual([]);
  });
});
