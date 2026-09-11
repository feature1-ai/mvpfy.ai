import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  composeCommand,
  ideCommand,
  ideContainerName,
  parseComposePs,
  seedCommandFor,
} from './docker';
import { IS_WIN } from './shell';

describe('composeCommand', () => {
  it('clears orphans on both halves, so a renamed service cannot hold its port', () => {
    // bootstrap rewrites the compose file; a service dropped from it is still
    // running, and compose will not touch it unless told to.
    expect(composeCommand('up')).toContain('up -d --build --remove-orphans');
    expect(composeCommand('down')).toContain('down --remove-orphans');
    const restart = composeCommand('restart');
    expect(restart).toContain('down --remove-orphans');
    expect(restart).toContain('up -d --build --remove-orphans');
  });

  it('never deletes volumes — Stop must not destroy the database', () => {
    for (const action of ['up', 'down', 'restart', 'logs'] as const) {
      expect(composeCommand(action), action).not.toContain('--volumes');
      expect(composeCommand(action), action).not.toContain('-v ');
    }
  });

  it('checks the daemon first for anything that starts or stops containers', () => {
    for (const action of ['up', 'down', 'restart'] as const) {
      expect(composeCommand(action).startsWith('docker info'), action).toBe(true);
    }
  });

  it('follows logs without waking the daemon, so it fails fast when down', () => {
    const logs = composeCommand('logs');
    expect(logs).toBe('docker compose -f docker-compose.mvpfy.yml logs -f --tail=200');
    expect(logs).not.toContain('docker info');
  });

  it('reads the compose file from .mvpfy/ for a linked project', () => {
    const linked = composeCommand('down', true);
    expect(linked).toContain('-f .mvpfy/docker-compose.mvpfy.yml');
    // Relative build contexts and volumes must still resolve to the repo root.
    expect(linked).toContain('--project-directory .');
  });
});

describe('ideCommand', () => {
  it('uses a separator and null device the platform understands', () => {
    const command = ideCommand('/Users/pm/code/shop', 'up', 8443);
    expect(command).toContain(IS_WIN ? '>NUL 2>&1 &' : '>/dev/null 2>&1;');
    // The stale container is cleared, then the new one starts regardless.
    expect(command).toContain(`docker rm -f ${ideContainerName('/Users/pm/code/shop')}`);
    expect(command).toContain('docker run -d --name');
  });

  it('refuses a port outside the safe range rather than building a bad command', () => {
    expect(() => ideCommand('/Users/pm/code/shop', 'up', 80)).toThrow(/valid port/);
    expect(() => ideCommand('/Users/pm/code/shop', 'up')).toThrow(/valid port/);
  });

  it('names the container from the workspace, safely', () => {
    expect(ideContainerName('/Users/pm/code/My App!')).toBe('mvpfy-ide-my-app-');
  });
});

describe('composeCommand force-down', () => {
  it('kills first, then tears down whatever is left', () => {
    const force = composeCommand('force-down');
    const killAt = force.indexOf(' kill ');
    const downAt = force.indexOf(' down --remove-orphans');
    expect(killAt).toBeGreaterThan(-1);
    expect(downAt).toBeGreaterThan(killAt);
  });

  it('tears down even though kill exits non-zero with nothing running', () => {
    // && would swallow the teardown on an already-stopped stack.
    const force = composeCommand('force-down');
    const between = force.slice(force.indexOf(' kill ') + 6, force.indexOf(' down --remove'));
    expect(between).toContain(IS_WIN ? '&' : ';');
    expect(between).not.toContain('&&');
  });

  it('is still not allowed to delete volumes', () => {
    expect(composeCommand('force-down')).not.toContain('--volumes');
  });
});

describe('parseComposePs', () => {
  const row = (service: string, state: string, exit = 0) =>
    JSON.stringify({ Name: `proj-${service}-1`, Service: service, State: state, ExitCode: exit });

  it('reads one object per line, which is what newer compose emits', () => {
    expect(parseComposePs([row('web', 'running'), row('db', 'exited', 1)].join('\n'))).toEqual([
      { service: 'web', state: 'running', exitCode: 0 },
      { service: 'db', state: 'exited', exitCode: 1 },
    ]);
  });

  it('reads a JSON array, which is what older compose emits', () => {
    const out = parseComposePs(`[${row('web', 'running')},${row('db', 'restarting')}]`);
    expect(out.map((r) => r.service)).toEqual(['web', 'db']);
    expect(out[1].state).toBe('restarting');
  });

  it('keeps the rows it can read when one line is torn', () => {
    expect(parseComposePs([row('web', 'running'), '{"Service":"db"'].join('\n'))).toEqual([
      { service: 'web', state: 'running', exitCode: 0 },
    ]);
  });

  it('says nothing rather than guessing when the output is unreadable', () => {
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('no such service')).toEqual([]);
  });

  it('falls back to the container name when a row has no service', () => {
    expect(parseComposePs(JSON.stringify({ Name: 'lonely', State: 'exited' }))[0].service).toBe(
      'lonely'
    );
  });
});

describe('seedCommandFor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-seed-'));
  const write = (yml: string) => fs.writeFileSync(path.join(dir, 'mvpfy.yml'), yml);
  afterEach(() => fs.rmSync(path.join(dir, 'mvpfy.yml'), { force: true }));

  it('reads the one line the project recorded', () => {
    write('app: shop\nseed_command: docker compose exec -T app npm run seed\nhost_port: 4100\n');
    expect(seedCommandFor(dir, false)).toBe('docker compose exec -T app npm run seed');
  });

  it('accepts a quoted command', () => {
    write('seed_command: "rails db:seed"\n');
    expect(seedCommandFor(dir, false)).toBe('rails db:seed');
  });

  it('is null when the project needs no seeding, which is not a failure', () => {
    write('app: shop\nhost_port: 4100\n');
    expect(seedCommandFor(dir, false)).toBeNull();
    expect(seedCommandFor(dir, false)).toBeNull();
  });

  it('is null when there is no mvpfy.yml at all', () => {
    expect(seedCommandFor(path.join(dir, 'nope'), false)).toBeNull();
  });

  it('ignores an empty value rather than running nothing', () => {
    write('seed_command:\n');
    expect(seedCommandFor(dir, false)).toBeNull();
  });

  it('stops at a comment, so a trailing note is not part of the command', () => {
    write('seed_command: npm run seed # idempotent\n');
    expect(seedCommandFor(dir, false)).toBe('npm run seed');
  });
});

describe('composeCommand rebuild', () => {
  it('builds from scratch and recreates, for a stack whose images were deleted', () => {
    const rebuild = composeCommand('rebuild');
    expect(rebuild).toContain('build --no-cache');
    expect(rebuild).toContain('--force-recreate');
    // Down first, so nothing is left from the old containers.
    expect(rebuild.indexOf(' down ')).toBeLessThan(rebuild.indexOf('build --no-cache'));
  });

  it('still refuses to delete volumes — this rebuilds the setup, not the data', () => {
    expect(composeCommand('rebuild')).not.toContain('--volumes');
  });

  it('checks the daemon first, like every other action that touches containers', () => {
    expect(composeCommand('rebuild').startsWith('docker info')).toBe(true);
  });
});
