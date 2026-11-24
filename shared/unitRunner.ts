/**
 * Long work, done as short pieces that are each checked before the next.
 *
 * One agent run that does everything has one way to be retried: all of it,
 * again. Split into units — a feature's stories, a setup's tasks — the work
 * can stop after any of them, pick up at the one that did not finish, and
 * send a failure back to be fixed while it is still about one thing.
 *
 * Two rules give that its value, and both are about who is believed.
 *
 * **A unit is done when a check says so, not when the work returns.** The
 * thing doing the work is usually an agent, and an agent that changed
 * nothing also returns. So the check is separate from the work and supplied
 * by the caller, who can make it look at evidence: a test suite's exit code,
 * a file on disk, a port that answers.
 *
 * **A failed check goes back as the next attempt's brief, a bounded number
 * of times.** Unbounded, a unit that cannot pass spends credit until
 * somebody notices. Bounded, it stops and names itself, which is the thing a
 * person can act on.
 *
 * Nothing here knows what a unit is, what the work costs, or how progress is
 * reported. The worker's engine drives stories through it; the desktop app's
 * setup can drive its tasks through the same loop.
 */

/** Which try this is, and why the one before it was not accepted. */
export interface UnitAttempt {
  /** 1 for the first try. */
  number: number;
  /** The most tries a unit gets. */
  of: number;
  /** What the check said last time. Absent on the first try. */
  failure?: string;
}

/** What doing the work came to. `stop` ends the whole run, not just the unit. */
export type WorkResult<Stop> = { kind: 'done' } | { kind: 'stop'; stop: Stop };

/** What checking it came to. */
export type CheckResult<Stop> =
  | { kind: 'passed' }
  /**
   * Not accepted. `failure` is written for whoever has to fix it, and may
   * quote what a command printed; it stays wherever the driver runs.
   *
   * `reportable` is the same verdict with nothing quoted from the work —
   * which command, in which repository, and that it failed. A driver that
   * tells anyone outside the machine why a unit failed must send this and
   * never `failure`: a test prints whatever the product it is testing prints,
   * and that can be a key, a customer record or an internal hostname.
   */
  | { kind: 'failed'; failure: string; reportable?: string }
  | { kind: 'stop'; stop: Stop };

/** Does a unit and judges it. The two are separate so neither can vouch for itself. */
export interface UnitDriver<Unit, Stop> {
  work(unit: Unit, attempt: UnitAttempt): Promise<WorkResult<Stop>>;
  check(unit: Unit, attempt: UnitAttempt): Promise<CheckResult<Stop>>;
}

/**
 * Remembers which units are finished.
 *
 * Kept by the caller because that is where durability lives: a checkpoint on
 * disk, a file the product manager is watching. A unit marked done is never
 * run again, which is what makes a resumed run pick up where it stopped.
 */
export interface UnitLedger<Unit> {
  isDone(unit: Unit): boolean;
  markDone(unit: Unit): void | Promise<void>;
}

export type UnitRunOutcome<Unit, Stop> =
  /** Every unit is done. */
  | { kind: 'completed' }
  /** The driver ended the run: cancelled, blocked on a person, crashed. */
  | { kind: 'stopped'; unit: Unit; stop: Stop }
  /** One unit used every attempt and its check still fails. */
  | {
      kind: 'exhausted';
      unit: Unit;
      attempts: number;
      failure: string;
      /** The last check's `reportable`, when it gave one. See CheckResult. */
      reportable?: string;
    };

export interface UnitRunOptions {
  /** Tries per unit, the first included. 1 means no repair at all. */
  maxAttempts: number;
}

/** A whole number of attempts, at least one, whatever was configured. */
export function attemptsFrom(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

/**
 * Run the units in order, stopping at the first that cannot be finished.
 *
 * In order and never in parallel: a later unit is usually built on an
 * earlier one, and a unit that failed is not something to build on.
 */
export async function runUnits<Unit, Stop>(
  units: readonly Unit[],
  driver: UnitDriver<Unit, Stop>,
  ledger: UnitLedger<Unit>,
  options: UnitRunOptions
): Promise<UnitRunOutcome<Unit, Stop>> {
  const of = attemptsFrom(options.maxAttempts);
  for (const unit of units) {
    if (ledger.isDone(unit)) continue;
    let failure: string | undefined;
    let reportable: string | undefined;
    let finished = false;
    for (let number = 1; number <= of && !finished; number++) {
      const attempt: UnitAttempt = { number, of, ...(failure === undefined ? {} : { failure }) };
      const worked = await driver.work(unit, attempt);
      if (worked.kind === 'stop') return { kind: 'stopped', unit, stop: worked.stop };
      const checked = await driver.check(unit, attempt);
      if (checked.kind === 'stop') return { kind: 'stopped', unit, stop: checked.stop };
      if (checked.kind === 'passed') finished = true;
      else {
        failure = checked.failure;
        reportable = checked.reportable;
      }
    }
    if (!finished) {
      return {
        kind: 'exhausted',
        unit,
        attempts: of,
        failure: failure ?? '',
        ...(reportable === undefined ? {} : { reportable }),
      };
    }
    await ledger.markDone(unit);
  }
  return { kind: 'completed' };
}
