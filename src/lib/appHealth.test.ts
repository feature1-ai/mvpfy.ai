import { describe, expect, it } from 'vitest';
import { appVerdict, QUIET_POLLS_BEFORE_STUCK } from './appHealth';
import type { ServiceState } from '../../shared/types';

const svc = (state: string, health = ''): ServiceState => ({
  service: 'web',
  state,
  exitCode: null,
  health,
});
const noisy = QUIET_POLLS_BEFORE_STUCK - 1;
const silent = QUIET_POLLS_BEFORE_STUCK;

describe('appVerdict', () => {
  it('is healthy the moment the app answers, whatever the containers say', () => {
    expect(appVerdict({ reachable: true, services: [svc('restarting')], quietPolls: 99 })).toBe(
      'healthy'
    );
  });

  it('waits indefinitely while the stack is still writing', () => {
    // The whole point: a slow machine is not a broken one. As long as
    // something is being logged, no amount of elapsed time makes this stuck.
    expect(appVerdict({ reachable: false, services: [svc('running')], quietPolls: 0 })).toBe(
      'starting'
    );
    expect(appVerdict({ reachable: false, services: [svc('running')], quietPolls: noisy })).toBe(
      'starting'
    );
  });

  it('gives up only when a running stack has gone completely silent', () => {
    expect(appVerdict({ reachable: false, services: [svc('running')], quietPolls: silent })).toBe(
      'stuck'
    );
  });

  it('does not wait at all for a container that died', () => {
    // A stopwatch was slowest exactly here — the answer was already known and
    // it spent ninety seconds anyway.
    expect(appVerdict({ reachable: false, services: [svc('exited')], quietPolls: 0 })).toBe(
      'stuck'
    );
    expect(appVerdict({ reachable: false, services: [svc('dead')], quietPolls: 0 })).toBe('stuck');
  });

  it('treats a crash loop as stuck, however busy its logs are', () => {
    // A container restarting forever writes plenty and gets nowhere.
    expect(appVerdict({ reachable: false, services: [svc('restarting')], quietPolls: 0 })).toBe(
      'stuck'
    );
  });

  it("believes the app's own healthcheck over anything inferred", () => {
    expect(
      appVerdict({ reachable: false, services: [svc('running', 'unhealthy')], quietPolls: 0 })
    ).toBe('stuck');
    // 'starting' means the app says it is not ready yet — so keep waiting,
    // even past the quiet limit.
    expect(
      appVerdict({ reachable: false, services: [svc('running', 'starting')], quietPolls: 999 })
    ).toBe('starting');
  });

  it('is patient with an empty status, which is usually compose still coming up', () => {
    expect(appVerdict({ reachable: false, services: [], quietPolls: 0 })).toBe('starting');
    expect(appVerdict({ reachable: false, services: [], quietPolls: silent })).toBe('stuck');
  });
});
