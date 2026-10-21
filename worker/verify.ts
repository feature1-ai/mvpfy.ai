import * as fs from 'node:fs';
import * as path from 'node:path';
import { Assignment, VerificationResult, VerificationStep } from '../shared/runner/contract';
import { CommandRunner } from './exec';
import { Redactor } from './redact';

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
    assignment: Assignment,
    repositoryId: string,
    opts: VerifyOptions
  ): Promise<VerificationResult[]> {
    const worktree = opts.worktrees[repositoryId];
    const given = assignment.verification.steps.filter((s) => s.repositoryId === repositoryId);
    let steps = given;
    let discovered = false;
    if (steps.length === 0 && assignment.verification.allowDiscovery && worktree) {
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
          reason: assignment.verification.allowDiscovery
            ? 'The assignment named no checks and none could be discovered here'
            : 'The assignment named no checks for this repository',
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
 * Something ran and said no.
 *
 * This is what fails an execution, and only this. An optional step never
 * does.
 */
export function verificationFailed(
  results: VerificationResult[],
  steps: VerificationStep[]
): boolean {
  const optional = new Set(steps.filter((s) => s.optional).map((s) => s.id));
  return results.some((r) => !optional.has(r.stepId) && r.outcome === 'failed');
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
