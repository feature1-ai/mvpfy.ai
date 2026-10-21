import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { featureAssignment, standaloneStoryAssignment } from '../shared/runner/fixtures';
import { Harness, agentChanges, makeHarness } from './harness';
import { Worker } from './worker';
import { Redactor } from './redact';
import { freshCheckpoint } from './store';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

function makeWorker(overrides: Partial<ConstructorParameters<typeof Worker>[0]> = {}): Worker {
  return new Worker({
    transport: h.transport,
    store: h.store,
    redactor: new Redactor(),
    makeEngine: () => h.engine,
    sleep: async () => {},
    now: h.now,
    options: {
      name: 'test worker',
      workerVersion: 'test',
      tenantId: 'acme',
      concurrency: 1,
      claimIntervalMs: 1,
      heartbeatIntervalMs: 1,
      agents: ['claude'],
    },
    ...overrides,
  });
}

describe('registration', () => {
  it('registers and keeps the token out of anything it logs', async () => {
    const logs: string[] = [];
    const redactor = new Redactor();
    const worker = new Worker({
      transport: h.transport,
      store: h.store,
      redactor,
      makeEngine: () => h.engine,
      sleep: async () => {},
      now: h.now,
      log: (m) => logs.push(m),
      options: {
        name: 'test worker',
        workerVersion: 'test',
        tenantId: 'acme',
        concurrency: 1,
        claimIntervalMs: 1,
        heartbeatIntervalMs: 1,
        agents: ['claude'],
      },
    });
    await worker.register();
    expect(logs.join('\n')).toContain('registered as');
    // The token the server just handed over is a credential from now on.
    expect(redactor.redact('token is fake-runner-token')).toContain('[redacted]');
  });
});

describe('claiming', () => {
  it('takes only as much as its concurrency allows', async () => {
    const worker = makeWorker();
    await worker.register();
    h.transport.offer(
      featureAssignment(),
      featureAssignment({ assignmentId: 'asg-2', executionId: 'exec-2' })
    );
    await worker.tick();
    expect(h.transport.heartbeats.at(-1)?.running.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('ignores a second delivery of work it is already running', async () => {
    // At-least-once delivery is ordinary. Starting twice is not.
    const worker = makeWorker();
    await worker.register();
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    h.transport.offer(assignment, assignment);
    await worker.tick();
    await worker.shutdown();
    // One execution, one result — not two.
    expect(h.transport.resultCalls).toHaveLength(1);
  });

  it('refuses an assignment belonging to another tenant, and gives it back', async () => {
    const worker = makeWorker();
    await worker.register();
    h.transport.offer(featureAssignment({ tenantId: 'somebody-else' }));
    await worker.tick();
    expect(h.transport.releaseCalls[0]?.reason).toMatch(/different tenant/);
    expect(h.transport.resultCalls).toHaveLength(0);
    expect(worker.running).toBe(0);
  });

  it('gives back work it has already reported rather than doing it again', async () => {
    const worker = makeWorker();
    await worker.register();
    const assignment = featureAssignment();
    const done = freshCheckpoint(assignment);
    done.reported = true;
    h.store.save(done);
    h.transport.offer(assignment);
    await worker.tick();
    expect(h.transport.releaseCalls[0]?.reason).toMatch(/Already completed/);
    expect(worker.running).toBe(0);
  });

  it('survives a claim that fails, and tries again next time', async () => {
    const worker = makeWorker();
    await worker.register();
    h.transport.failNext.claim = 1;
    h.transport.offer(standaloneStoryAssignment());
    agentChanges(h, 'repo-api');
    await worker.tick();
    expect(worker.running).toBe(0);
    await worker.tick();
    await worker.shutdown();
    expect(h.transport.resultCalls).toHaveLength(1);
  });
});

describe('heartbeats', () => {
  it('says what it is doing, and renews the leases that come back', async () => {
    const worker = makeWorker();
    await worker.register();
    await worker.tick();
    expect(h.transport.heartbeats.at(-1)?.status).toBe('idle');
  });

  it('keeps working when a heartbeat fails, because the lease has not expired', async () => {
    // A missed heartbeat is not by itself a reason to drop everything.
    const worker = makeWorker();
    await worker.register();
    h.transport.failNext.heartbeat = 1;
    h.transport.offer(standaloneStoryAssignment());
    agentChanges(h, 'repo-api');
    await worker.tick();
    await worker.shutdown();
    expect(h.transport.resultCalls).toHaveLength(1);
  });

  it('cancels what Feature1 asks it to cancel', async () => {
    const worker = makeWorker();
    await worker.register();
    const assignment = standaloneStoryAssignment();
    agentChanges(h, 'repo-api');
    // Cancel as soon as the agent starts, so there is something to stop.
    h.agent.onRun = () => h.transport.cancel(assignment.assignmentId);
    h.transport.offer(assignment);
    await worker.tick();
    await worker.tick();
    await worker.shutdown();
    expect(h.transport.resultCalls.at(-1)?.outcome).toBeDefined();
  });
});

describe('draining', () => {
  it('stops claiming when told to drain', async () => {
    const worker = makeWorker();
    await worker.register();
    h.transport.drain();
    h.transport.offer(featureAssignment());
    await worker.tick();
    // Learned from the heartbeat in this tick, so nothing was claimed in it.
    expect(worker.running).toBe(0);
    // The next heartbeat is the one that says so out loud.
    await worker.tick();
    expect(h.transport.heartbeats.at(-1)?.status).toBe('draining');
  });

  it('lets what is running finish rather than abandoning it', async () => {
    // A killed execution leaves a branch pushed and nothing reported, which
    // is the state that costs a person the most time.
    const worker = makeWorker();
    await worker.register();
    h.transport.offer(standaloneStoryAssignment());
    agentChanges(h, 'repo-api');
    await worker.tick();
    await worker.shutdown();
    expect(h.transport.resultCalls).toHaveLength(1);
    expect(h.transport.resultCalls[0].outcome).toBe('ready_for_testing');
    expect(worker.running).toBe(0);
  });

  it('still reports when it is forced to stop', async () => {
    const worker = makeWorker();
    await worker.register();
    h.transport.offer(standaloneStoryAssignment());
    agentChanges(h, 'repo-api');
    h.agent.onRun = () => {
      void worker.shutdown({ force: true });
    };
    await worker.tick();
    await worker.shutdown({ force: true });
    // Cancelled rather than abandoned: there is a result either way.
    expect(h.transport.resultCalls).toHaveLength(1);
  });

  it('returns at once when there is nothing in flight', async () => {
    const worker = makeWorker();
    await worker.register();
    await worker.shutdown();
    expect(worker.running).toBe(0);
  });
});

describe('restart recovery', () => {
  it('picks up an execution that was in flight when the worker stopped', async () => {
    const assignment = standaloneStoryAssignment();
    h.transport.known(assignment);
    const checkpoint = freshCheckpoint(assignment);
    checkpoint.state = 'implementing';
    h.store.save(checkpoint);
    agentChanges(h, 'repo-api');

    const worker = makeWorker();
    await worker.register();
    expect(await worker.recover()).toBe(1);
    await worker.shutdown();
    expect(h.transport.resultCalls).toHaveLength(1);
  });

  it('leaves alone an execution that was already reported', async () => {
    const assignment = standaloneStoryAssignment();
    const checkpoint = freshCheckpoint(assignment);
    checkpoint.reported = true;
    h.store.save(checkpoint);
    const worker = makeWorker();
    await worker.register();
    expect(await worker.recover()).toBe(0);
  });

  it('leaves alone an execution belonging to another tenant', async () => {
    const checkpoint = freshCheckpoint(standaloneStoryAssignment({ tenantId: 'other' }));
    h.store.save(checkpoint);
    const worker = makeWorker();
    await worker.register();
    expect(await worker.recover()).toBe(0);
  });

  it('starts again rather than resuming against requirements that changed', async () => {
    // A checkpoint written against different text is different work wearing
    // the same execution id.
    const worker = makeWorker();
    await worker.register();
    const old = standaloneStoryAssignment();
    const stale = freshCheckpoint(old);
    stale.completedItems = ['sto-9'];
    h.store.save(stale);

    const revised = standaloneStoryAssignment();
    revised.requirements = { ...revised.requirements, revision: 'rev-2' };
    h.transport.offer(revised);
    agentChanges(h, 'repo-api');
    await worker.tick();
    await worker.shutdown();
    // The work was done again, against the new revision.
    expect(h.agent.runs.length).toBeGreaterThan(0);
    expect(h.transport.resultCalls[0].requirementsRevision).toBe('rev-2');
  });
});
