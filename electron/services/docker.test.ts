import { describe, expect, it } from 'vitest';
import { composeCommand, ideCommand, ideContainerName } from './docker';
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
