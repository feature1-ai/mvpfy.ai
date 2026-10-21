import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_VERSION,
  PermanentTransportError,
  StaleAttemptError,
  TransientTransportError,
} from '../shared/runner/contract';
import { HttpFeature1Transport } from './httpTransport';
import { withRetry } from './transport';
import { FakeFeature1 } from './fakeFeature1';
import { featureAssignment } from '../shared/runner/fixtures';

function respondWith(status: number, body = ''): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe('HttpFeature1Transport', () => {
  const base = { baseUrl: 'https://acme.feature1.ai' };

  it('refuses a plaintext base URL that is not localhost', () => {
    // The runner token travels on every request.
    expect(() => new HttpFeature1Transport({ baseUrl: 'http://acme.feature1.ai' })).toThrow(
      /https/
    );
    expect(
      () => new HttpFeature1Transport({ baseUrl: 'http://localhost:4000', fetchImpl: fetch })
    ).not.toThrow();
  });

  it('turns a lost claim into a stale attempt, which is never retried', async () => {
    for (const status of [409, 412, 423]) {
      const t = new HttpFeature1Transport({ ...base, fetchImpl: respondWith(status) });
      await expect(t.progress({} as never)).rejects.toBeInstanceOf(StaleAttemptError);
    }
  });

  it('separates a server that said no from one that might say yes later', async () => {
    const permanent = new HttpFeature1Transport({ ...base, fetchImpl: respondWith(400, 'bad') });
    await expect(permanent.progress({} as never)).rejects.toBeInstanceOf(PermanentTransportError);

    for (const status of [500, 503, 429]) {
      const transient = new HttpFeature1Transport({ ...base, fetchImpl: respondWith(status) });
      await expect(transient.progress({} as never)).rejects.toBeInstanceOf(TransientTransportError);
    }
  });

  it('treats an unreachable server as transient, because the call may not have happened', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await expect(t.claim({} as never)).rejects.toBeInstanceOf(TransientTransportError);
  });

  it('refuses to register against a server speaking another contract version', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(200, JSON.stringify({ contractVersion: 'other/2020-01-01' })),
    });
    await expect(t.register({} as never)).rejects.toThrow(/speaks other/);
  });

  it('parses claimed assignments rather than trusting them', async () => {
    // An assignment decides what gets cloned and what commands run.
    const poisoned = { ...featureAssignment() };
    poisoned.repositories[0].cloneUrl = 'ext::sh -c id';
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(200, JSON.stringify({ assignments: [poisoned] })),
    });
    await expect(t.claim({} as never)).rejects.toThrow(/cloneUrl/);
  });

  it('accepts a well-formed claim', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(200, JSON.stringify({ assignments: [featureAssignment()] })),
    });
    const res = await t.claim({ contractVersion: CONTRACT_VERSION, runnerId: 'r', capacity: 1 });
    expect(res.assignments[0].executionId).toBe('exec-feature-1');
  });
});

describe('withRetry', () => {
  const sleep = async () => {};

  it('gives up immediately on a stale attempt', async () => {
    // Retrying is exactly how two workers both report.
    const operation = vi.fn(async () => {
      throw new StaleAttemptError();
    });
    await expect(withRetry(operation, { sleep })).rejects.toBeInstanceOf(StaleAttemptError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up immediately when the server understood and said no', async () => {
    const operation = vi.fn(async () => {
      throw new PermanentTransportError('no');
    });
    await expect(withRetry(operation, { sleep })).rejects.toBeInstanceOf(PermanentTransportError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries what might succeed, and returns when it does', async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        if (++calls < 3) throw new TransientTransportError('later');
        return 'done';
      },
      { sleep }
    );
    expect(value).toBe('done');
    expect(calls).toBe(3);
  });

  it('eventually stops', async () => {
    const operation = vi.fn(async () => {
      throw new TransientTransportError('always');
    });
    await expect(withRetry(operation, { sleep, attempts: 4 })).rejects.toThrow(/always/);
    expect(operation).toHaveBeenCalledTimes(4);
  });
});

describe('FakeFeature1', () => {
  it('refuses a write from an attempt that is no longer live', async () => {
    // The fencing check the real server has to make.
    const fake = new FakeFeature1();
    const assignment = featureAssignment();
    fake.offer(assignment);
    await fake.claim({ contractVersion: CONTRACT_VERSION, runnerId: 'r', capacity: 1 });
    fake.supersede(assignment.executionId, 'token-2');
    await expect(
      fake.progress({
        contractVersion: CONTRACT_VERSION,
        runnerId: 'r',
        assignmentId: assignment.assignmentId,
        attemptToken: 'token-1',
        state: 'implementing',
        detail: 'still going',
        idempotencyKey: 'k',
      })
    ).rejects.toBeInstanceOf(StaleAttemptError);
  });

  it('records a repeated idempotency key once', async () => {
    const fake = new FakeFeature1();
    const assignment = featureAssignment();
    fake.offer(assignment);
    const send = () =>
      fake.result({
        contractVersion: CONTRACT_VERSION,
        runnerId: 'r',
        assignmentId: assignment.assignmentId,
        attemptToken: assignment.attemptToken,
        outcome: 'ready_for_testing',
        summary: 'done',
        repositories: [],
        requirementsRevision: 'rev-3',
        idempotencyKey: 'the-same-key',
      });
    await send();
    await send();
    expect(fake.resultCalls).toHaveLength(1);
    expect(fake.acceptedCount('the-same-key')).toBe(2);
  });

  it('hands out no more work than the capacity asked for', async () => {
    const fake = new FakeFeature1();
    fake.offer(featureAssignment(), featureAssignment({ assignmentId: 'asg-2' }));
    const first = await fake.claim({
      contractVersion: CONTRACT_VERSION,
      runnerId: 'r',
      capacity: 1,
    });
    expect(first.assignments).toHaveLength(1);
    const second = await fake.claim({
      contractVersion: CONTRACT_VERSION,
      runnerId: 'r',
      capacity: 0,
    });
    expect(second.assignments).toHaveLength(0);
  });

  it('stops offering work once draining', async () => {
    const fake = new FakeFeature1();
    fake.offer(featureAssignment());
    fake.drain();
    const res = await fake.claim({ contractVersion: CONTRACT_VERSION, runnerId: 'r', capacity: 3 });
    expect(res.assignments).toHaveLength(0);
  });
});
