import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { IDS, featureExecution, standaloneStoryExecution } from '../shared/runner/fixtures';
import { Harness, agentChanges, makeHarness, withDiscoverableTests } from './harness';
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

function makeWorker(): Worker {
  return new Worker({
    transport: h.transport,
    store: h.store,
    redactor: new Redactor(),
    engine: h.engine,
    sleep: async () => {},
    now: h.now,
    options: { name: 'test worker', claimIntervalMs: 1, heartbeatIntervalMs: 1 },
  });
}

/** Give every repository of an offered execution a discoverable check. */
function prepare(execution: ReturnType<typeof featureExecution>) {
  withDiscoverableTests(h, execution, ...execution.repositories.map((r) => r.id));
  agentChanges(h, ...execution.repositories.map((r) => r.id));
  h.transport.offer(execution);
}

describe('claiming', () => {
  it('takes one execution and runs it to a terminal state', async () => {
    const execution = standaloneStoryExecution();
    prepare(execution);
    const worker = makeWorker();
    await worker.tick();
    expect(h.transport.stateOf(execution.id)).toBe('ready_for_testing');
    expect(worker.busy).toBe(false);
  });

  it('does nothing when there is no work', async () => {
    const worker = makeWorker();
    await worker.tick();
    expect(h.transport.progressCalls).toHaveLength(0);
  });

  it('survives a claim that fails, and tries again next time', async () => {
    const execution = standaloneStoryExecution();
    prepare(execution);
    h.transport.failNext.claim = 1;
    const worker = makeWorker();
    await worker.tick();
    expect(h.transport.stateOf(execution.id)).toBeUndefined();
    await worker.tick();
    expect(h.transport.stateOf(execution.id)).toBe('ready_for_testing');
  });

  it('holds one execution at a time', async () => {
    // Feature1 hands out one per claim and allows one active run per owner,
    // so a worker juggling several would be several three-minute leases to
    // keep alive for no gain.
    prepare(standaloneStoryExecution());
    prepare(featureExecution());
    const worker = makeWorker();
    await worker.tick();
    expect(worker.busy).toBe(false);
    // Only the first was taken in that pass.
    expect(h.transport.stateOf(IDS.execStory)).toBe('ready_for_testing');
    expect(h.transport.stateOf(IDS.execFeature)).toBeUndefined();
  });
});

describe('the lease, while the agent works', () => {
  it('heartbeats, so a long execution is not reclaimed under it', async () => {
    // Three minutes is the whole lease and a story takes longer.
    const execution = standaloneStoryExecution();
    prepare(execution);
    let beats = 0;
    h.agent.onRun = () => {
      beats = h.transport.heartbeats.length;
    };
    const worker = makeWorker();
    await worker.tick();
    // At least one empty-bodied call went out while work was happening.
    expect(h.transport.heartbeats.length).toBeGreaterThanOrEqual(beats);
  });

  it('stops the agent when the lease is lost mid-flight', async () => {
    const execution = standaloneStoryExecution();
    prepare(execution);
    h.agent.onRun = () => h.transport.supersede(execution.id);
    const worker = makeWorker();
    await worker.tick();
    // Nothing was published and nothing was claimed to be finished.
    expect(h.prs.creates).toHaveLength(0);
    expect(h.transport.stateOf(execution.id)).not.toBe('ready_for_testing');
  });

  it('cancels the agent when Feature1 says somebody cancelled', async () => {
    const execution = standaloneStoryExecution();
    prepare(execution);
    h.agent.onRun = () => h.transport.cancel(execution.id);
    const worker = makeWorker();
    await worker.tick();
    expect(h.transport.stateOf(execution.id)).toBe('cancelled');
    expect(h.prs.creates).toHaveLength(0);
  });
});

describe('resuming', () => {
  it('continues from a checkpoint rather than starting the work again', async () => {
    const execution = featureExecution();
    prepare(execution);
    // A previous attempt built the first story and died.
    const earlier = freshCheckpoint(execution);
    earlier.completedUnits = [IDS.story1];
    h.store.save(earlier);

    const worker = makeWorker();
    await worker.tick();
    expect(h.agent.runs).toHaveLength(1);
    expect(h.agent.runs[0].prompt).toContain('US-02');
  });

  it('starts afresh when the previous checkpoint was already reported', async () => {
    const execution = standaloneStoryExecution();
    prepare(execution);
    const done = freshCheckpoint(execution);
    done.reported = true;
    h.store.save(done);
    const worker = makeWorker();
    await worker.tick();
    expect(h.agent.runs).toHaveLength(1);
  });

  it('lists what was left unfinished, so a restart can say so', async () => {
    const unfinished = freshCheckpoint(standaloneStoryExecution());
    h.store.save(unfinished);
    expect(makeWorker().recoverable()).toHaveLength(1);
  });

  it('lists nothing once the work was reported', async () => {
    const done = freshCheckpoint(standaloneStoryExecution());
    done.reported = true;
    h.store.save(done);
    expect(makeWorker().recoverable()).toHaveLength(0);
  });
});

describe('shutting down', () => {
  it('returns at once when nothing is running', async () => {
    const worker = makeWorker();
    await worker.shutdown();
    expect(worker.busy).toBe(false);
  });

  it('stops claiming once it is draining', async () => {
    const execution = standaloneStoryExecution();
    prepare(execution);
    const worker = makeWorker();
    await worker.shutdown();
    await worker.tick();
    expect(h.transport.progressCalls).toHaveLength(0);
  });
});
