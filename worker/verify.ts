import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkEnv } from './childEnv';
import { discoverChecks } from './discovery';
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
  /** Runs in an ecosystem's image on the workspace's Docker engine (discovery.ts). */
  needsEngine?: boolean;
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
  /**
   * The end of what a failing command printed, redacted. Kept on the worker
   * and handed to the agent that has to fix it; never sent to Feature1.
   */
  output?: string;
  /**
   * A step whose failure does not fail the repository — carried on the
   * result, because the engine judges results and never sees the steps that
   * discovery chose (it passed none, so a failing optional lint failed the
   * repository anyway).
   */
  optional?: boolean;
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
 *
 * (The rule itself is enforced in canReport, below.)
 */

const DEFAULT_STEP_TIMEOUT = 20 * 60_000;

/**
 * Whether a node_modules folder holds anything. A test link's stack mounts
 * one into the checkout as an empty mount point (a volume over
 * /app/node_modules), so its being there said nothing: the checks then
 * found no test runner and nothing ran.
 */
function installed(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name !== '.DS_Store');
  } catch {
    return false;
  }
}

/** The last few lines, which is where a test runner puts its summary. */
function summarise(text: string, redactor: Redactor): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return redactor.line(lines.slice(-3).join(' · ')) || '(no output)';
}

/**
 * Enough of a failure to fix it from.
 *
 * Both streams, because test runners disagree about which one carries the
 * assertion, and the end of each, because that is where the failure is.
 */
function failureOutput(stdout: string, stderr: string, redactor: Redactor): string {
  const tail = (text: string) => text.trim().slice(-FAILURE_OUTPUT_CHARS);
  return redactor.redact([tail(stdout), tail(stderr)].filter(Boolean).join('\n'));
}

const FAILURE_OUTPUT_CHARS = 3000;

export class Verifier {
  constructor(
    private readonly runner: CommandRunner,
    private readonly redactor: Redactor,
    // The repo's own scripts run here; they get no credentials (childEnv.ts).
    private readonly env: NodeJS.ProcessEnv = checkEnv(),
    /**
     * Whether to install a JavaScript checkout's dependencies first. Not where
     * the checks run in the product's own running container, which has them.
     */
    private readonly options: { install?: boolean } = {}
  ) {}

  /**
   * Commands worth trying when the assignment named none.
   *
   * The engine names no steps, so this is how every repository is checked:
   * the contract leaves choosing the checks to the worker. Every result from
   * here is marked `discovered`, because "tests passed" from a command nobody
   * asked for is a weaker claim than one that was specified, and the report
   * should not blur the two.
   */
  discoverSteps(repositoryId: string, worktree: string): VerificationStep[] {
    return discoverChecks(worktree).map((check) => ({
      id: `${check.id}-${repositoryId}`,
      kind: check.kind,
      name: check.name,
      command: check.command,
      repositoryId,
      ...(check.optional ? { optional: true } : {}),
      ...(check.needsEngine ? { needsEngine: true } : {}),
    }));
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
      ...(step.optional ? { optional: true } : {}),
    };
    if (step.needsEngine && !this.env.DOCKER_HOST) {
      return {
        ...base,
        outcome: 'unavailable',
        exitCode: null,
        durationMs: 0,
        summary: 'Not run',
        reason:
          "This check runs in its language's own image, on the workspace's Docker engine, and this runner has none",
      };
    }
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
      env: this.env,
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
      ...(res.code === 0 ? {} : { output: failureOutput(res.stdout, res.stderr, this.redactor) }),
    };
  }

  /** Every step for one repository, in order. */
  /**
   * Install a JavaScript repository's dependencies when its checkout has
   * none, so its checks can start at all.
   *
   * A fresh checkout has no node_modules, and `npm test` then fails as "not
   * found" — which reads as nothing to run, not as a failure. A build of
   * three stories went through all of them that way with not one test run,
   * and only the final check noticed. The install runs where the checks run,
   * with the same environment and no credentials; its own scripts are the
   * repository's code like any other.
   *
   * Resolves with nothing when there was nothing to do or it worked, and
   * with a failed result, carrying the end of the installer's output, when
   * it did not.
   */
  private async installDependencies(
    repositoryId: string,
    worktree: string,
    signal?: AbortSignal
  ): Promise<VerificationResult | null> {
    const has = (file: string) => fs.existsSync(path.join(worktree, file));
    if (!has('package.json') || installed(path.join(worktree, 'node_modules'))) return null;
    const install = has('pnpm-lock.yaml')
      ? 'corepack pnpm install --frozen-lockfile'
      : has('yarn.lock')
        ? 'corepack yarn install --frozen-lockfile'
        : has('package-lock.json') || has('npm-shrinkwrap.json')
          ? 'npm ci --no-audit --no-fund'
          : 'npm install --no-audit --no-fund';
    // Never committed by accident, whatever the repository's own .gitignore says.
    const exclude =
      'git check-ignore -q node_modules || echo node_modules/ >> "$(git rev-parse --git-path info/exclude)"';
    const started = Date.now();
    const res = await this.runner.run(`${exclude}; ${install}`, {
      cwd: worktree,
      env: this.env,
      timeoutMs: 20 * 60_000,
      ...(signal ? { signal } : {}),
    });
    if (res.code === 0) return null;
    const output = this.redactor.redact(`${res.stdout}\n${res.stderr}`).trim().split('\n');
    return {
      stepId: `install-${repositoryId}`,
      kind: 'other',
      name: 'Installing dependencies',
      command: install,
      repositoryId,
      outcome: res.cancelled ? 'skipped' : 'failed',
      exitCode: res.code,
      durationMs: Date.now() - started,
      summary: `\`${install}\` did not finish`,
      output: output.slice(-40).join('\n'),
    };
  }

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
    if (discovered && worktree && this.options.install !== false) {
      const installed = await this.installDependencies(repositoryId, worktree, opts.signal);
      // Checks that cannot start without the dependencies say only "not
      // found"; this says why, and goes back to the agent as a failure.
      if (installed) return [installed];
    }
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
  return results.some((r) => !r.optional && !optional.has(r.stepId) && r.outcome === 'failed');
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
