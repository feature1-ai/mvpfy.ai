import { describe, expect, it } from 'vitest';
import { RepositoryChecks, failureBrief } from './checks';
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

  it('does not remember a run that was interrupted or ran nothing', async () => {
    const c = setup([
      [result({ outcome: 'skipped', exitCode: null })],
      [result({ outcome: 'unavailable', exitCode: null })],
    ]);
    await c.verify();
    await c.verify();
    await c.verify();
    expect(c.runs()).toBe(3);
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
