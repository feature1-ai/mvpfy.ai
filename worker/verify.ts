import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommandRunner } from './exec';
import { Redactor } from './redact';

/**
 * A command the worker decides to run in a repository.
 *
 * Feature1 does not send these. It takes the *result* — and only passing
 * ones — so choosing what to run is the worker's job, and saying honestly
 * what it chose is part of the record.
 */
export interface VerificationStep {
  id: string;
  kind: 'test' | 'lint' | 'build' | 'typecheck' | 'other';
  name: string;
  command: string;
  repositoryId: string;
  optional?: boolean;
  timeoutMs?: number;
}

export type VerificationOutcome = 'passed' | 'failed' | 'skipped' | 'unavailable';

export interface VerificationResult {
  stepId: string;
  kind: VerificationStep['kind'];
  name: string;
  command: string;
  repositoryId: string;
  outcome: VerificationOutcome;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  reason?: string;
  discovered?: boolean;
}

/**
 * Deciding whether it actually worked.
 *
 * The rule this file exists for: **a successful agent exit is not proof of
 * anything.** An agent that writes no code at all exits zero. So verification
 * is run by the worker, against commands the assignment named, and the result
 * records what was run, what it returned, and how long it took.
 *
 * The other rule is that a check which could not run is never counted as a
 * pass. "No test script in this repository" and "every test passed" are
 * wildly different claims, and a reviewer reading `ready_for_testing` has to
 * be able to tell them apart — so `unavailable` is its own outcome, with the
 * reason beside it.
 */

export interface VerifyOptions {
  signal?: AbortSignal;
  /** Where each repository's checkout is, by repository id. */
  worktrees: Record<string, string>;
}

/**
 * What Feature1 needs, and what the worker therefore has to produce.
 *
 * The server accepts a repository result only when it carries at least one
 * command with exit code zero. There is no way to report a repository whose
 * checks failed, and no way to report one where nothing ran: both are a
 * failed execution with a message instead.
 *
 * That is a stricter bar than the worker set for itself, and it is the
 * right way round — "ready for testing" with nothing tested was always a
 * weak claim. It does mean a repository with no runnable check cannot be
 * handed over, which is worth knowing before pointing a worker at one.
 */
export const VERIFICATION_IS_MANDATORY = true;

const DEFAULT_STEP_TIMEOUT = 20 * 60_000;

/** The last few lines, which is where a test runner puts its summary. */
function summarise(text: string, redactor: Redactor): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return redactor.line(lines.slice(-3).join(' · ')) || '(no output)';
}

export class Verifier {
  constructor(
    private readonly runner: CommandRunner,
    private readonly redactor: Redactor
  ) {}

  /**
   * Commands worth trying when the assignment named none.
   *
   * Only offered when the assignment sets `allowDiscovery`, and every result
   * from it is marked `discovered` — because "tests passed" from a command
   * nobody asked for is a weaker claim than one that was specified, and the
   * report should not blur the two.
   */
  discoverSteps(repositoryId: string, worktree: string): VerificationStep[] {
    const steps: VerificationStep[] = [];
    const packageJson = path.join(worktree, 'package.json');
    if (fs.existsSync(packageJson)) {
      try {
        const scripts = (JSON.parse(fs.readFileSync(packageJson, 'utf8'))?.scripts ?? {}) as Record<
          string,
          string
        >;
        if (scripts.test) {
          steps.push({
            id: `discovered-test-${repositoryId}`,
            kind: 'test',
            name: 'npm test',
            command: 'npm test --silent',
            repositoryId,
          });
        }
        if (scripts.lint) {
          steps.push({
            id: `discovered-lint-${repositoryId}`,
            kind: 'lint',
            name: 'npm run lint',
            command: 'npm run lint --silent',
            repositoryId,
            optional: true,
          });
        }
      } catch {
        // An unreadable package.json discovers nothing, which is reported as
        // "no verification could be discovered" rather than as a failure.
      }
    }
    return steps;
  }

  /** Run one step and say exactly what happened. */
  async runStep(
    step: VerificationStep,
    worktree: string | undefined,
    opts: { signal?: AbortSignal; discovered?: boolean }
  ): Promise<VerificationResult> {
    const base = {
      stepId: step.id,
      kind: step.kind,
      name: step.name,
      command: this.redactor.line(step.command, 200),
      repositoryId: step.repositoryId,
      ...(opts.discovered ? { discovered: true } : {}),
    };
    if (!worktree) {
      return {
        ...base,
        outcome: 'unavailable',
        exitCode: null,
        durationMs: 0,
        summary: 'Not run',
        reason: `No checkout for ${step.repositoryId}, so this could not run`,
      };
    }
    const res = await this.runner.run(step.command, {
      cwd: worktree,
      timeoutMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.cancelled) {
      return {
        ...base,
        outcome: 'skipped',
        exitCode: res.code,
        durationMs: res.durationMs,
        summary: 'Cancelled',
        reason: 'The execution was cancelled while this was running',
      };
    }
    if (res.timedOut) {
      return {
        ...base,
        outcome: 'unavailable',
        exitCode: res.code,
        durationMs: res.durationMs,
        summary: summarise(res.stdout || res.stderr, this.redactor),
        reason: `Took longer than ${(step.timeoutMs ?? DEFAULT_STEP_TIMEOUT) / 1000}s and was stopped`,
      };
    }
    // 127 is the shell saying it could not find the command. Reporting that
    // as a failing test would send somebody looking for a bug in the code.
    if (res.code === 127) {
      return {
        ...base,
        outcome: 'unavailable',
        exitCode: 127,
        durationMs: res.durationMs,
        summary: summarise(res.stderr || res.stdout, this.redactor),
        reason: 'The command was not found in this checkout',
      };
    }
    return {
      ...base,
      outcome: res.code === 0 ? 'passed' : 'failed',
      exitCode: res.code,
      durationMs: res.durationMs,
      summary: summarise(res.code === 0 ? res.stdout : res.stderr || res.stdout, this.redactor),
    };
  }

  /** Every step for one repository, in order. */
  async verifyRepository(
    repositoryId: string,
    opts: VerifyOptions & { steps?: VerificationStep[] }
  ): Promise<VerificationResult[]> {
    const worktree = opts.worktrees[repositoryId];
    let steps = opts.steps ?? [];
    let discovered = false;
    if (steps.length === 0 && worktree) {
      steps = this.discoverSteps(repositoryId, worktree);
      discovered = true;
    }
    if (steps.length === 0) {
      // Said out loud rather than left as an empty list: a reviewer must not
      // read "nothing failed" as "everything was checked".
      return [
        {
          stepId: `none-${repositoryId}`,
          kind: 'other',
          name: 'Verification',
          command: '',
          repositoryId,
          outcome: 'unavailable',
          exitCode: null,
          durationMs: 0,
          summary: 'Nothing was verified',
          reason: 'No runnable check could be found in this repository',
        },
      ];
    }
    const results: VerificationResult[] = [];
    for (const step of steps) {
      results.push(
        await this.runStep(step, worktree, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          discovered,
        })
      );
    }
    return results;
  }
}

/**
 * Something ran and said no. An optional step never counts.
 */
export function verificationFailed(
  results: VerificationResult[],
  steps: VerificationStep[]
): boolean {
  const optional = new Set(steps.filter((s) => s.optional).map((s) => s.id));
  return results.some((r) => !optional.has(r.stepId) && r.outcome === 'failed');
}

/**
 * Whether this repository can be handed to Feature1 at all.
 *
 * It needs at least one command that ran and passed, and nothing that ran
 * and failed. Anything else and the server refuses the result — so the
 * worker finds out here, before it spends a lease discovering it.
 */
export function canReport(
  results: VerificationResult[],
  steps: VerificationStep[]
): { ok: true } | { ok: false; reason: string } {
  if (verificationFailed(results, steps)) {
    const failed = results.filter((r) => r.outcome === 'failed');
    return {
      ok: false,
      reason: `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${failed
        .map((r) => r.name)
        .join(', ')}`,
    };
  }
  if (!results.some((r) => r.outcome === 'passed')) {
    const why = results.find((r) => r.reason)?.reason ?? 'nothing ran';
    return { ok: false, reason: `No check passed in this repository — ${why}` };
  }
  return { ok: true };
}

/**
 * Everything required actually passed.
 *
 * Deliberately not the same question as the one above, because
 * `unavailable` sits between them and the difference matters.
 *
 * A repository with no test script tells us nothing — but nothing failed in
 * it either, and reporting that execution as `failed` would state something
 * untrue about work that may be perfectly good. It would also make the
 * worker useless against the many real repositories that have no suite.
 * `ready_for_testing` is the honest outcome there: a person now has to test
 * it, which is exactly what the state is called.
 *
 * So this decides the wording rather than the outcome. The result carries
 * every step, its outcome and the reason it could not run, and the pull
 * request body puts the same table in front of the reviewer — nobody has to
 * read "ready" as "checked".
 */
export function verificationHeld(
  results: VerificationResult[],
  steps: VerificationStep[]
): boolean {
  const optional = new Set(steps.filter((s) => s.optional).map((s) => s.id));
  return results.every((r) => optional.has(r.stepId) || r.outcome === 'passed');
}
