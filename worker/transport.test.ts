import { describe, expect, it, vi } from 'vitest';
import {
  PermanentTransportError,
  ProtocolMismatchError,
  StaleAttemptError,
  TransientTransportError,
} from '../shared/runner/contract';
import { CLAIM_PATH, HttpFeature1Transport, progressPath } from './httpTransport';
import { withRetry } from './transport';
import { FakeFeature1 } from './fakeFeature1';
import { IDS, featureExecution, standaloneStoryExecution } from '../shared/runner/fixtures';

const TOKEN = 'a'.repeat(64);
const base = { baseUrl: 'https://acme.feature1.ai', runnerToken: TOKEN };

function respondWith(status: number, body = ''): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe('HttpFeature1Transport', () => {
  it('posts to the paths Feature1 actually mounts', () => {
    expect(CLAIM_PATH).toBe('/api/implementation-runs/worker/claim');
    expect(progressPath('exec-1')).toBe('/api/implementation-runs/worker/exec-1/progress');
  });

  it('refuses a plaintext base URL that is not localhost', () => {
    // The runner credential travels on every request.
    expect(
      () => new HttpFeature1Transport({ ...base, baseUrl: 'http://acme.feature1.ai' })
    ).toThrow(/https/);
    expect(
      () => new HttpFeature1Transport({ ...base, baseUrl: 'http://localhost:4000' })
    ).not.toThrow();
  });

  it('refuses a credential that is not the shape Feature1 mints', () => {
    // 64 hex, or the server answers 401 and it looks like an outage.
    expect(() => new HttpFeature1Transport({ ...base, runnerToken: 'nope' })).toThrow(
      /64 hexadecimal/
    );
  });

  it('sends the lease in a header and never in the body', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ execution: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = new HttpFeature1Transport({ ...base, fetchImpl });
    await t.progress('exec-1', 'lease-abc', { state: 'implementing' });
    expect((seen?.headers as Record<string, string>)['X-Execution-Lease']).toBe('lease-abc');
    expect((seen?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(seen?.body)).not.toContain('lease-abc');
  });

  it('turns 409 into a stale attempt, which is never retried', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(409, JSON.stringify({ error: 'Lease expired or superseded' })),
    });
    await expect(t.progress('e', 'l', {})).rejects.toBeInstanceOf(StaleAttemptError);
  });

  it('says what a 404 probably means, rather than only the number', async () => {
    // Every worker route answers 404 until MVPFY_IMPLEMENTATION_ENABLED is
    // set, which is worth knowing before blaming the credential.
    const t = new HttpFeature1Transport({ ...base, fetchImpl: respondWith(404) });
    await expect(t.claim()).rejects.toThrow(/MVPFY_IMPLEMENTATION_ENABLED/);
  });

  it('separates a server that said no from one that might say yes later', async () => {
    const permanent = new HttpFeature1Transport({ ...base, fetchImpl: respondWith(400, 'bad') });
    await expect(permanent.progress('e', 'l', {})).rejects.toBeInstanceOf(PermanentTransportError);
    for (const status of [500, 503, 429]) {
      const transient = new HttpFeature1Transport({ ...base, fetchImpl: respondWith(status) });
      await expect(transient.claim()).rejects.toBeInstanceOf(TransientTransportError);
    }
  });

  it('treats an unreachable server as transient, because the call may not have happened', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await expect(t.claim()).rejects.toBeInstanceOf(TransientTransportError);
  });

  it('surfaces the sentence Feature1 wrote, not just the status', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(
        400,
        JSON.stringify({ error: 'Passing verification commands are required' })
      ),
    });
    await expect(t.progress('e', 'l', {})).rejects.toThrow(/Passing verification commands/);
  });

  it('returns null when there is no work', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(200, JSON.stringify({ success: true, execution: null })),
    });
    expect(await t.claim()).toBeNull();
  });

  it('parses a claimed execution rather than trusting it', async () => {
    const poisoned = featureExecution();
    poisoned.repositories[0].url = 'ext::sh -c id';
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(200, JSON.stringify({ execution: poisoned })),
    });
    await expect(t.claim()).rejects.toThrow(/url/);
  });

  it('refuses a protocol version it does not speak', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(
        200,
        JSON.stringify({ execution: { ...featureExecution(), protocol_version: 9 } })
      ),
    });
    await expect(t.claim()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it('accepts a well-formed claim', async () => {
    const t = new HttpFeature1Transport({
      ...base,
      fetchImpl: respondWith(200, JSON.stringify({ execution: featureExecution() })),
    });
    expect((await t.claim())?.id).toBe(IDS.execFeature);
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
      throw new PermanentTransportError('malformed');
    });
    await expect(withRetry(operation, { sleep })).rejects.toBeInstanceOf(PermanentTransportError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries what might succeed', async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        if (++calls < 3) throw new TransientTransportError('later');
        return 'done';
      },
      { sleep }
    );
    expect(value).toBe('done');
  });

  it('backs off well inside the three-minute lease', async () => {
    // A backoff that outlasts the lease hands the execution to somebody
    // else while we wait.
    const waits: number[] = [];
    await withRetry(
      async () => {
        throw new TransientTransportError('always');
      },
      { attempts: 6, sleep: async (ms) => void waits.push(ms) }
    ).catch(() => undefined);
    expect(Math.max(...waits)).toBeLessThanOrEqual(20_000);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(120_000);
  });
});

describe('FakeFeature1', () => {
  it('refuses a write once the execution has been superseded', async () => {
    const fake = new FakeFeature1();
    fake.offer(standaloneStoryExecution());
    const claimed = await fake.claim();
    fake.supersede(claimed!.id);
    await expect(fake.progress(claimed!.id, claimed!.lease_token, {})).rejects.toBeInstanceOf(
      StaleAttemptError
    );
  });

  it('lets a terminal state be acknowledged twice with the same lease', async () => {
    // The server does, which is what makes a crash between sending and
    // recording safe.
    const fake = new FakeFeature1();
    fake.offer(standaloneStoryExecution());
    const claimed = await fake.claim();
    const body = { state: 'failed' as const, message: 'stopped' };
    await fake.progress(claimed!.id, claimed!.lease_token, body);
    await expect(fake.progress(claimed!.id, claimed!.lease_token, body)).resolves.toBeTruthy();
  });

  it('answers cancel_requested instead of accepting ordinary progress', async () => {
    const fake = new FakeFeature1();
    fake.offer(standaloneStoryExecution());
    const claimed = await fake.claim();
    fake.cancel(claimed!.id);
    const res = await fake.progress(claimed!.id, claimed!.lease_token, { state: 'verifying' });
    expect(res.cancel_requested).toBe(true);
  });

  it('refuses to move an execution backwards', async () => {
    const fake = new FakeFeature1();
    fake.offer(standaloneStoryExecution());
    const claimed = await fake.claim();
    await fake.progress(claimed!.id, claimed!.lease_token, { state: 'verifying' });
    await expect(
      fake.progress(claimed!.id, claimed!.lease_token, { state: 'implementing' })
    ).rejects.toThrow(/backwards/);
  });

  it('refuses a result that is not green, as the server does', async () => {
    const fake = new FakeFeature1();
    const execution = standaloneStoryExecution();
    fake.offer(execution);
    const claimed = await fake.claim();
    await expect(
      fake.progress(claimed!.id, claimed!.lease_token, {
        repository_result: {
          repository_id: IDS.repoApi,
          outcome: 'pr_created',
          base_commit: 'a'.repeat(40),
          head_commit: 'b'.repeat(40),
          tests: [{ command: 'npm test', exit_code: 1 }],
          pr_urls: ['https://github.com/acme/api/pull/1'],
        },
      })
    ).rejects.toThrow(/only passing/);
  });

  it('refuses ready_for_testing until every repository has reported', async () => {
    const fake = new FakeFeature1();
    fake.offer(featureExecution());
    const claimed = await fake.claim();
    await expect(
      fake.progress(claimed!.id, claimed!.lease_token, { state: 'ready_for_testing' })
    ).rejects.toThrow(/Every selected repository/);
  });

  it('hands back a reclaimed run with the results already accepted', async () => {
    let now = Date.parse('2026-10-22T11:00:00.000Z');
    const fake = new FakeFeature1({ now: () => now });
    fake.offer(standaloneStoryExecution());
    const first = await fake.claim();
    await fake.progress(first!.id, first!.lease_token, {
      repository_result: {
        repository_id: IDS.repoApi,
        outcome: 'no_changes',
        base_commit: 'a'.repeat(40),
        head_commit: 'a'.repeat(40),
        tests: [{ command: 'npm test', exit_code: 0 }],
        pr_urls: [],
      },
    });
    // The lease runs out and somebody picks it up again.
    now += 4 * 60_000;
    const second = await fake.claim();
    expect(second?.id).toBe(first?.id);
    expect(second?.attempt).toBe((first?.attempt ?? 0) + 1);
    expect(second?.results[IDS.repoApi].outcome).toBe('no_changes');
    expect(second?.lease_token).not.toBe(first?.lease_token);
  });
});
