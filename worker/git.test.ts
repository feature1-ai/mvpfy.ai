import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikeSecret, parseStatus, withCloneLock } from './git';

const z = (...entries: string[]) => entries.join('\0') + '\0';

describe('parseStatus', () => {
  it('takes modified, deleted and new files by path', () => {
    expect(parseStatus(z(' M src/app.ts', ' D old.ts', '?? src/new.ts')).paths).toEqual([
      'src/app.ts',
      'old.ts',
      'src/new.ts',
    ]);
  });

  it('takes the new side of a staged rename and never the mangled original', () => {
    // -z puts the original after the new path as its own entry; reading it as
    // `XY path` turned "src/old.ts" into "/old.ts" and git add failed.
    expect(parseStatus(z('R  src/new.ts', 'src/old.ts', ' M README.md')).paths).toEqual([
      'src/new.ts',
      'README.md',
    ]);
  });

  it('takes only the new side of a copy, and keeps reading after it', () => {
    expect(parseStatus(z('C  b.ts', 'a.ts', '?? c.ts')).paths).toEqual(['b.ts', 'c.ts']);
  });

  it('keeps paths with spaces exactly', () => {
    expect(parseStatus(z('?? docs/read me.md')).paths).toEqual(['docs/read me.md']);
  });

  it('withholds a new file that looks like a credential', () => {
    const { paths, withheld } = parseStatus(z('?? .env', '?? api/.env.local', '?? src/a.ts'));
    expect(paths).toEqual(['src/a.ts']);
    expect(withheld).toEqual(['.env', 'api/.env.local']);
  });

  it('leaves a tracked file that happens to look like one to the repository', () => {
    expect(parseStatus(z(' M .env')).paths).toEqual(['.env']);
  });

  it('reads empty output as nothing to commit', () => {
    expect(parseStatus('')).toEqual({ paths: [], withheld: [] });
  });
});

describe('looksLikeSecret', () => {
  it('catches the usual credential files', () => {
    for (const file of [
      '.env',
      '.env.local',
      '.env.production',
      'server.pem',
      'certs/tls.key',
      'id_rsa',
      'id_ed25519',
      '.npmrc',
      '.netrc',
      'credentials.json',
      'home/.ssh/config',
      '.aws/credentials',
    ]) {
      expect(looksLikeSecret(file), file).toBe(true);
    }
  });

  it('lets code and templates meant to be committed through', () => {
    for (const file of [
      '.env.example',
      '.env.sample',
      '.env.template',
      'src/env.ts',
      'environment.md',
      'id_rsa.pub',
      'keyboard.tsx',
      'src/keys.ts',
    ]) {
      expect(looksLikeSecret(file), file).toBe(false);
    }
  });
});

describe('one runner at a time in a shared clone', () => {
  it('lets one in at a time, lets the holder in again, and takes over a dead one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-lock-'));
    try {
      const clone = path.join(dir, 'clone');
      const order: string[] = [];
      const slow = (name: string) => async () => {
        order.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`${name} out`);
      };
      await Promise.all([
        withCloneLock(clone, slow('a'), { pollMs: 5 }),
        withCloneLock(clone, slow('b'), { pollMs: 5 }),
      ]);
      // Never both inside at once.
      expect(order).toEqual(['a in', 'a out', 'b in', 'b out']);

      // Fetching inside adding a worktree: the same holder, so no wait.
      expect(await withCloneLock(clone, () => withCloneLock(clone, async () => 'nested'))).toBe(
        'nested'
      );
      expect(fs.existsSync(`${clone}.lock`)).toBe(false);

      // Left by a runner that died: untouched for long enough, it is taken over.
      fs.mkdirSync(`${clone}.lock`);
      const old = new Date(Date.now() - 11 * 60_000);
      fs.utimesSync(`${clone}.lock`, old, old);
      expect(await withCloneLock(clone, async () => 'taken', { pollMs: 5 })).toBe('taken');

      // Held by a live one: waited for, then given up on.
      fs.mkdirSync(`${clone}.lock`);
      await expect(
        withCloneLock(clone, async () => 'never', { waitMs: 30, pollMs: 5 })
      ).rejects.toThrow(/held clone too long/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
