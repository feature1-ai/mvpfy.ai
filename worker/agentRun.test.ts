import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_MCP_TOKEN_ENV } from '../shared/agentMcp';
import { CliAgentRunner } from './agentRun';
import { CommandResult, CommandRunner, RunOptions } from './exec';

const MCP = { url: 'https://acme-mcp.feature1.ai/mcp/', token: 'f1r_read_only_for_this_run' };
const ok: CommandResult = {
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  cancelled: false,
  durationMs: 1,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-agent-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A runner that looks at what exists while the agent would be running. */
function observing(seen: { command?: string; env?: NodeJS.ProcessEnv; files: string[] }) {
  const runner: CommandRunner = {
    async run(command: string, opts: RunOptions) {
      seen.command = command;
      seen.env = opts.env;
      seen.files = fs.readdirSync(path.join(dir, 'agent'));
      const config = seen.files.find((f) => f.startsWith('mcp-'));
      if (config) seen.files.push(fs.readFileSync(path.join(dir, 'agent', config), 'utf8'));
      return ok;
    },
  };
  return runner;
}

const input = (kind: 'claude' | 'codex', mcp?: typeof MCP) => ({
  kind,
  prompt: 'build it',
  cwd: dir,
  agentDir: path.join(dir, 'agent'),
  questionsFile: path.join(dir, 'agent', 'mvpfy-questions.md'),
  ...(mcp ? { mcp } : {}),
});

describe('handing the agent Feature1’s MCP server', () => {
  it('gives Claude Code a config file for the run, and takes it away afterwards', async () => {
    const seen = { files: [] as string[] };
    await new CliAgentRunner(observing(seen), { PATH: '/usr/bin' }).run(input('claude', MCP));

    expect(seen.command).toContain('--mcp-config');
    // In a file the agent reads, not in a process list anybody can.
    expect(seen.command).not.toContain(MCP.token);
    expect(seen.files.join('\n')).toContain(`Bearer ${MCP.token}`);
    expect(seen.files.join('\n')).toContain(MCP.url);
    expect(fs.readdirSync(path.join(dir, 'agent'))).toEqual([]);
  });

  it('gives Codex the token in its environment and the address in a flag', async () => {
    const seen = { files: [] as string[] };
    await new CliAgentRunner(observing(seen), { PATH: '/usr/bin' }).run(input('codex', MCP));

    expect(seen.command).toContain('mcp_servers.feature1=');
    expect(seen.command).toContain(CODEX_MCP_TOKEN_ENV);
    expect(seen.command).not.toContain(MCP.token);
    expect(seen.env?.[CODEX_MCP_TOKEN_ENV]).toBe(MCP.token);
  });

  it('registers nothing when Feature1 issued nothing', async () => {
    for (const kind of ['claude', 'codex'] as const) {
      const seen = { files: [] as string[] };
      await new CliAgentRunner(observing(seen), { PATH: '/usr/bin' }).run(input(kind));
      expect(seen.command).not.toContain('mcp');
      expect(seen.env).toEqual({ PATH: '/usr/bin' });
      expect(seen.files.filter((f) => f.startsWith('mcp-'))).toEqual([]);
    }
  });

  it('removes the config file even when the agent could not be run', async () => {
    const failing: CommandRunner = {
      async run() {
        throw new Error('spawn failed');
      },
    };
    await expect(
      new CliAgentRunner(failing, { PATH: '/usr/bin' }).run(input('claude', MCP))
    ).rejects.toThrow(/spawn failed/);
    expect(fs.readdirSync(path.join(dir, 'agent'))).toEqual([]);
  });
});
