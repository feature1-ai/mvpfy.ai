import { describe, expect, it } from 'vitest';
import { CheckResult, UnitAttempt, UnitDriver, attemptsFrom, runUnits } from './unitRunner';

/** A driver scripted per unit: the check results it gives, in order. */
function scripted(checks: Record<string, Array<CheckResult<string>>>) {
  const worked: Array<{ unit: string; attempt: UnitAttempt }> = [];
  const done: string[] = [];
  const driver: UnitDriver<string, string> = {
    async work(unit, attempt) {
      worked.push({ unit, attempt });
      return { kind: 'done' };
    },
    async check(unit) {
      return checks[unit]?.shift() ?? { kind: 'passed' };
    },
  };
  const ledger = {
    isDone: (unit: string) => done.includes(unit),
    markDone: (unit: string) => void done.push(unit),
  };
  return { driver, ledger, worked, done };
}

const failed = (failure: string): CheckResult<string> => ({ kind: 'failed', failure });

describe('runUnits', () => {
  it('does every unit once, in order, when each one passes', async () => {
    const s = scripted({});
    const outcome = await runUnits(['a', 'b', 'c'], s.driver, s.ledger, { maxAttempts: 3 });
    expect(outcome).toEqual({ kind: 'completed' });
    expect(s.worked.map((w) => w.unit)).toEqual(['a', 'b', 'c']);
    expect(s.done).toEqual(['a', 'b', 'c']);
  });

  it('skips what is already done, which is how a resumed run picks up', async () => {
    const s = scripted({});
    s.done.push('a');
    await runUnits(['a', 'b'], s.driver, s.ledger, { maxAttempts: 3 });
    expect(s.worked.map((w) => w.unit)).toEqual(['b']);
  });

  it('sends a failed check back as the next attempt’s brief', async () => {
    const s = scripted({ a: [failed('test x is red')] });
    const outcome = await runUnits(['a'], s.driver, s.ledger, { maxAttempts: 3 });
    expect(outcome).toEqual({ kind: 'completed' });
    expect(s.worked.map((w) => w.attempt)).toEqual([
      { number: 1, of: 3 },
      { number: 2, of: 3, failure: 'test x is red' },
    ]);
  });

  it('carries the latest failure, not the first', async () => {
    const s = scripted({ a: [failed('first'), failed('second')] });
    await runUnits(['a'], s.driver, s.ledger, { maxAttempts: 3 });
    expect(s.worked.at(-1)?.attempt.failure).toBe('second');
  });

  it('stops at a unit that cannot pass, names it, and builds nothing on it', async () => {
    const s = scripted({ b: [failed('1'), failed('2'), failed('3')] });
    const outcome = await runUnits(['a', 'b', 'c'], s.driver, s.ledger, { maxAttempts: 3 });
    expect(outcome).toEqual({ kind: 'exhausted', unit: 'b', attempts: 3, failure: '3' });
    expect(s.done).toEqual(['a']);
    expect(s.worked.some((w) => w.unit === 'c')).toBe(false);
  });

  it('carries the last reportable verdict out with the exhausted unit', async () => {
    // `failure` may quote what a command printed and stays on the machine that
    // ran it; `reportable` is the version safe to tell a server. The outcome
    // has to carry both, or the caller is left redacting the wrong one.
    const s = scripted({
      a: [
        { kind: 'failed', failure: 'first, with output', reportable: 'first, without' },
        { kind: 'failed', failure: 'second, with output', reportable: 'second, without' },
      ],
    });
    const outcome = await runUnits(['a'], s.driver, s.ledger, { maxAttempts: 2 });
    expect(outcome).toMatchObject({
      kind: 'exhausted',
      failure: 'second, with output',
      reportable: 'second, without',
    });
  });

  it('leaves reportable off when the check never gave one', async () => {
    const s = scripted({ a: [failed('no reportable here')] });
    const outcome = await runUnits(['a'], s.driver, s.ledger, { maxAttempts: 1 });
    expect(outcome).not.toHaveProperty('reportable');
  });

  it('does not repair at all when one attempt is all a unit gets', async () => {
    const s = scripted({ a: [failed('red')] });
    const outcome = await runUnits(['a'], s.driver, s.ledger, { maxAttempts: 1 });
    expect(outcome).toMatchObject({ kind: 'exhausted', attempts: 1 });
    expect(s.worked).toHaveLength(1);
  });

  it('ends the whole run when the work says stop, without checking it', async () => {
    let checked = 0;
    const outcome = await runUnits<string, string>(
      ['a', 'b'],
      {
        work: async () => ({ kind: 'stop', stop: 'cancelled' }),
        check: async () => {
          checked += 1;
          return { kind: 'passed' };
        },
      },
      { isDone: () => false, markDone: () => {} },
      { maxAttempts: 3 }
    );
    expect(outcome).toEqual({ kind: 'stopped', unit: 'a', stop: 'cancelled' });
    expect(checked).toBe(0);
  });

  it('ends the whole run when the check says stop, and does not mark the unit done', async () => {
    const s = scripted({ a: [{ kind: 'stop', stop: 'cancelled' }] });
    const outcome = await runUnits(['a', 'b'], s.driver, s.ledger, { maxAttempts: 3 });
    expect(outcome).toEqual({ kind: 'stopped', unit: 'a', stop: 'cancelled' });
    expect(s.done).toEqual([]);
  });

  it('waits for the ledger before starting the next unit', async () => {
    const order: string[] = [];
    await runUnits<string, string>(
      ['a', 'b'],
      {
        work: async (unit) => {
          order.push(`work ${unit}`);
          return { kind: 'done' };
        },
        check: async () => ({ kind: 'passed' }),
      },
      {
        isDone: () => false,
        markDone: async (unit) => {
          await new Promise((r) => setTimeout(r, 5));
          order.push(`saved ${unit}`);
        },
      },
      { maxAttempts: 1 }
    );
    expect(order).toEqual(['work a', 'saved a', 'work b', 'saved b']);
  });

  it('is complete with nothing to do', async () => {
    const s = scripted({});
    expect(await runUnits([], s.driver, s.ledger, { maxAttempts: 3 })).toEqual({
      kind: 'completed',
    });
  });
});

describe('attemptsFrom', () => {
  it('always allows the first try, whatever was configured', () => {
    expect(attemptsFrom(0)).toBe(1);
    expect(attemptsFrom(-2)).toBe(1);
    expect(attemptsFrom(Number.NaN)).toBe(1);
    expect(attemptsFrom(2.9)).toBe(2);
  });
});
