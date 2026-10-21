import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCommandFor, codexCommandFor, codexMcpConfig, sweepRunArtifacts } from './agents';
import { shellQuote } from './shell';

let dir: string;

describe('Codex Feature1 configuration', () => {
  it('uses an environment token rather than exposing it in the command', () => {
    const config = codexMcpConfig({ url: 'https://example.com/mcp', token: 'private-token' });
    expect(config.flag).toContain('mcp_servers.feature1=');
    expect(config.flag).toContain('MVPFY_FEATURE1_TOKEN');
    expect(config.flag).not.toContain('private-token');
    expect(config.env).toEqual({ MVPFY_FEATURE1_TOKEN: 'private-token' });
  });
  it('rejects tokenless Feature1 agent runs', () => {
    expect(() => codexMcpConfig({ url: 'https://example.com/mcp' })).toThrow(
      /personal bearer token/
    );
  });
});

/** Create an entry and backdate it so the age check can be exercised. */
function make(name: string, ageMs: number, isDir = false): string {
  const target = path.join(dir, name);
  if (isDir) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'auth.json'), 'secret');
  } else {
    fs.writeFileSync(target, 'secret');
  }
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(target, when, when);
  return target;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-sweep-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sweepRunArtifacts', () => {
  const HOUR = 60 * 60_000;

  it('removes stale per-run scratch, including the ones holding credentials', () => {
    make('prompt-run1.txt', 2 * HOUR);
    make('mcp-run1.json', 2 * HOUR);
    make('codex-home-run1', 2 * HOUR, true);
    sweepRunArtifacts(HOUR, dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('leaves scratch a live run may still be using', () => {
    make('mcp-run2.json', 5 * 60_000);
    make('codex-home-run2', 5 * 60_000, true);
    sweepRunArtifacts(HOUR, dir);
    expect(fs.readdirSync(dir).sort()).toEqual(['codex-home-run2', 'mcp-run2.json']);
  });

  it('never touches anything that is not per-run scratch', () => {
    make('state.json', 10 * HOUR);
    make('secrets.json', 10 * HOUR);
    make('projects', 10 * HOUR, true);
    sweepRunArtifacts(HOUR, dir);
    expect(fs.readdirSync(dir).sort()).toEqual(['projects', 'secrets.json', 'state.json']);
  });

  it('does not throw when the directory is missing', () => {
    expect(() => sweepRunArtifacts(HOUR, path.join(dir, 'nope'))).not.toThrow();
  });
});

describe('session flags', () => {
  const build = (session?: { id: string; resume: boolean }) =>
    claudeCommandFor(
      { ...(session ? { session } : {}) },
      { repoPath: '/x/repo', promptFile: '/tmp/p.txt' }
    );

  it('names the conversation on the run that opens it', () => {
    expect(build({ id: 'abc-123', resume: false })).toContain(
      '--session-id ' + shellQuote('abc-123')
    );
  });

  it('continues it on every run after', () => {
    const command = build({ id: 'abc-123', resume: true });
    expect(command).toContain('--resume ' + shellQuote('abc-123'));
    expect(command).not.toContain('--session-id');
  });

  it('passes neither when the run belongs to no conversation', () => {
    const command = build();
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--resume');
  });

  it('keeps the flag ahead of -p, where claude expects its options', () => {
    const command = build({ id: 'abc', resume: true });
    expect(command.indexOf('--resume')).toBeLessThan(command.indexOf(' -p '));
  });
});

describe('codexCommandFor', () => {
  const opts = { repoPath: '/w/proj', promptFile: '/tmp/p.txt' };

  it('opens a new thread when the feature has none yet', () => {
    // Codex cannot be handed an id for a thread that does not exist, so the
    // first run of a feature must not try.
    const cmd = codexCommandFor({}, opts);
    expect(cmd).toContain('codex exec --sandbox');
    expect(cmd).not.toContain('resume');
  });

  it('continues the feature thread once one is known', () => {
    const cmd = codexCommandFor({ session: { id: 'thread-1', resume: true } }, opts);
    expect(cmd).toContain("codex exec resume 'thread-1'");
  });

  it('never invents an id for a thread codex has not opened', () => {
    // resume:false means mvpfy minted the id (the Claude path). Handing it to
    // codex would resume nothing and silently open a second conversation.
    const cmd = codexCommandFor({ session: { id: 'invented', resume: false } }, opts);
    expect(cmd).not.toContain('resume');
    expect(cmd).not.toContain('invented');
  });

  it('keeps resume ahead of the flags, where the subcommand belongs', () => {
    const cmd = codexCommandFor(
      { session: { id: 't', resume: true }, model: 'gpt-5', images: ['/tmp/a.png'] },
      { ...opts, mcpFlag: '--mcp x ' }
    );
    expect(cmd).toMatch(/codex exec resume 't' --mcp x --image '\/tmp\/a\.png' --model 'gpt-5'/);
  });

  it('reads the prompt from the file rather than the command line', () => {
    expect(codexCommandFor({}, opts)).toContain("--json - < '/tmp/p.txt'");
  });
});
