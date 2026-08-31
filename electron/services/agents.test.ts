import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepRunArtifacts } from './agents';

let dir: string;

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
