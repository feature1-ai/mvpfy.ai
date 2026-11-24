import { describe, expect, it } from 'vitest';
import { RepositoryChecks, failureBrief, failureSummary } from './checks';
import { VerificationResult } from './verify';

const result = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  stepId: 'test',
  kind: 'test',
  name: 'npm test',
  command: 'npm test --silent',
  repositoryId: 'api',
  outcome: 'passed',
  exitCode: 0,
  durationMs: 1,
  summary: 'ok',
  ...over,
});

/** Checks that answer from a script, over a branch the test can move. */
function setup(script: VerificationResult[][]) {
  let head: string | Error = 'a'.repeat(40);
  let runs = 0;
  const checks = new RepositoryChecks(
    {
      async verifyRepository() {
        runs += 1;
        return script.shift() ?? [result()];
      },
    },
    {
      async headCommit() {
        if (head instanceof Error) throw head;
        return head;
      },
    }
  );
  return {
    verify: () => checks.verify('api', { api: '/tmp/api' }),
    runs: () => runs,
    move: (to: string | Error) => {
      head = to;
    },
  };
}

describe('RepositoryChecks', () => {
  it('does not run a suite again at a commit it already passed at', async () => {
    const c = setup([]);
    const first = await c.verify();
    expect(await c.verify()).toBe(first);
    expect(c.runs()).toBe(1);
  });

  it('runs it again once the branch has moved', async () => {
    const c = setup([]);
    await c.verify();
    c.move('b'.repeat(40));
    await c.verify();
    expect(c.runs()).toBe(2);
  });

  it('always runs a failure again, so a fix or a flaky test gets its second look', async () => {
    const c = setup([[result({ outcome: 'failed', exitCode: 1 })]]);
    expect((await c.verify())[0].outcome).toBe('failed');
    expect((await c.verify())[0].outcome).toBe('passed');
    expect(c.runs()).toBe(2);
  });

  it('does not remember a run that was interrupted', async () => {
    const c = setup([
      [result({ outcome: 'skipped', exitCode: null })],
      [result({ outcome: 'skipped', exitCode: null })],
    ]);
    await c.verify();
    await c.verify();
    await c.verify();
    expect(c.runs()).toBe(3);
  });

  it('asks only once when nothing could be run at all', async () => {
    // A command that timed out or does not exist is a fact about the command,
    // not about the code, so asking again costs the same and learns nothing.
    // A timeout is twenty minutes, and this used to be paid once per story and
    // once per repair attempt — over an hour for a five-story feature, which
    // then failed at publish for the reason the first run already knew.
    const c = setup([[result({ outcome: 'unavailable', exitCode: null })]]);
    expect((await c.verify())[0].outcome).toBe('unavailable');
    expect((await c.verify())[0].outcome).toBe('unavailable');
    await c.verify();
    expect(c.runs()).toBe(1);
  });

  it('remembers a pass beside a failing optional check', async () => {
    const c = setup([
      [result(), result({ name: 'lint', outcome: 'failed', exitCode: 1, optional: true })],
    ]);
    await c.verify();
    await c.verify();
    expect(c.runs()).toBe(1);
  });

  it('just runs the checks when the branch cannot be read', async () => {
    const c = setup([]);
    c.move(new Error('not a git repository'));
    await c.verify();
    await c.verify();
    expect(c.runs()).toBe(2);
  });
});

describe('failureBrief', () => {
  it('names the repository, the command and the end of its output', () => {
    const brief = failureBrief([
      {
        repositoryName: 'api',
        result: result({ outcome: 'failed', exitCode: 1, output: 'expected 200, received 500' }),
      },
    ]);
    expect(brief).toContain('In api, `npm test --silent` exited with code 1.');
    expect(brief).toContain('expected 200, received 500');
  });

  it('falls back to the summary when nothing was captured', () => {
    const brief = failureBrief([
      {
        repositoryName: 'web',
        result: result({ outcome: 'failed', exitCode: 2, summary: '3 failing' }),
      },
    ]);
    expect(brief).toContain('3 failing');
  });
});

describe('failureSummary', () => {
  const secret = 'sk-live-0000000000000000';

  it('says which command failed where, without quoting what it printed', () => {
    const failures = [
      {
        repositoryName: 'api',
        result: result({
          outcome: 'failed',
          exitCode: 1,
          output: `AuthError using ${secret} against db-prod-7.internal`,
          summary: '3 failing',
        }),
      },
    ];
    const summary = failureSummary(failures);
    expect(summary).toContain('api: `npm test --silent` exited with code 1');
    // The point of the function. verify.ts promises output stays on the
    // worker, and this is the value the engine reports to Feature1, so
    // anything a test printed has to be absent — not shortened, not redacted.
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain('db-prod-7.internal');
    expect(summary).not.toContain(failureBrief(failures));
  });

  it('counts them when more than one repository failed', () => {
    const summary = failureSummary([
      { repositoryName: 'api', result: result({ outcome: 'failed', exitCode: 1 }) },
      { repositoryName: 'web', result: result({ outcome: 'failed', exitCode: 2 }) },
    ]);
    expect(summary).toContain('2 checks failed');
    expect(summary).toContain('api:');
    expect(summary).toContain('web:');
  });

  it('never contains an output field, whatever is in it', () => {
    // A property-ish guard: the only inputs are structured, so no value from
    // `output` should reach the string by any route.
    // Each probe is a distinctive multi-character string: a single letter
    // would collide with the command name and fail for a reason that is not
    // the one being tested.
    const probes = [
      secret,
      'db-prod-7.internal',
      JSON.stringify({ secret }),
      'Error: ENOTFOUND redis-cache-eu',
      'a'.repeat(5000),
    ];
    for (const output of probes) {
      const summary = failureSummary([
        { repositoryName: 'api', result: result({ outcome: 'failed', exitCode: 1, output }) },
      ]);
      expect(summary).not.toContain(output);
    }
  });
});
