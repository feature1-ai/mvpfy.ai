import { Git } from './git';
import { VerificationResult, Verifier, verificationFailed } from './verify';

/**
 * A repository's checks, run when its branch has moved and not otherwise.
 *
 * Checking after every unit is what lets a failure be sent back while it is
 * still about one story. Done naively it also means running every suite
 * after every story, and then once more before publishing — for a feature of
 * five stories that touch one repository of three, fifteen runs where five
 * mattered.
 *
 * So a result is kept against the commit it was true of. A repository whose
 * branch has not moved since its checks last passed is not run again: the
 * answer is already known, about exactly this code.
 *
 * Only a pass is kept. A failure is always run again, because the reason to
 * ask again is usually that something was just changed to fix it — and when
 * nothing was, a second run is how a flaky test stops failing an execution.
 *
 * A third outcome is kept differently. When nothing ran at all — the command
 * timed out, or does not exist — that is a statement about the command rather
 * than about the code, and re-running it learns nothing while costing the same
 * again. A timeout is twenty minutes; paid once per story and once per repair
 * attempt, a five-story feature spends over an hour discovering the same thing
 * five times and then fails at publish anyway. So it is remembered for the
 * whole execution, not against a commit, and the trade is deliberate: a story
 * that fixes a hanging command will not be noticed until the next execution.
 */
export class RepositoryChecks {
  private readonly passedAt = new Map<string, { head: string; results: VerificationResult[] }>();
  private readonly nothingRan = new Map<string, VerificationResult[]>();

  constructor(
    private readonly verifier: Pick<Verifier, 'verifyRepository'>,
    private readonly git: Pick<Git, 'headCommit'>
  ) {}

  async verify(
    repositoryId: string,
    worktrees: Record<string, string>,
    signal?: AbortSignal
  ): Promise<VerificationResult[]> {
    const stuck = this.nothingRan.get(repositoryId);
    if (stuck) return stuck;
    const head = await this.headOf(worktrees[repositoryId]);
    const known = this.passedAt.get(repositoryId);
    if (head && known?.head === head) return known.results;

    const results = await this.verifier.verifyRepository(repositoryId, {
      worktrees,
      ...(signal ? { signal } : {}),
    });
    // Kept only when it is a statement about finished code: something ran,
    // nothing failed, and nobody interrupted it.
    const settled =
      !verificationFailed(results, []) &&
      results.some((r) => r.outcome === 'passed') &&
      !results.some((r) => r.outcome === 'skipped');
    if (head && settled) this.passedAt.set(repositoryId, { head, results });
    else this.passedAt.delete(repositoryId);
    // Nothing ran and nothing failed: every command was unavailable. Not a
    // verdict on the code, and not worth asking again at the same price.
    // Guarded on a non-empty list so a repository with no checks configured
    // keeps its existing behaviour of being asked each time.
    if (
      !settled &&
      results.length > 0 &&
      results.every((r) => r.outcome === 'unavailable') &&
      !signal?.aborted
    ) {
      this.nothingRan.set(repositoryId, results);
    }
    return results;
  }

  /** The branch tip, or nothing when it cannot be read — which only costs a re-run. */
  private async headOf(worktree: string | undefined): Promise<string | null> {
    if (!worktree) return null;
    try {
      return await this.git.headCommit(worktree);
    } catch {
      return null;
    }
  }
}

/**
 * A failed check, written for whoever has to fix it.
 *
 * The command and the end of its output, per repository, because that is
 * what a person would paste to a colleague. The output is already redacted
 * by the runner that captured it.
 */
export function failureBrief(
  failures: Array<{ repositoryName: string; result: VerificationResult }>
): string {
  return failures
    .map(({ repositoryName, result }) =>
      [
        `In ${repositoryName}, \`${result.command}\` exited with code ${result.exitCode ?? 'unknown'}.`,
        result.output?.trim() ? `The end of its output:\n${result.output.trim()}` : result.summary,
      ].join('\n')
    )
    .join('\n\n');
}

/**
 * The same failure with nothing quoted from the work — safe to send to
 * Feature1, which failureBrief is not.
 *
 * `VerificationResult.output` is the tail of what a command printed, and a
 * test prints whatever the product it tests prints: a key from a fixture, a
 * row from a seeded database, the hostname of something internal. The
 * redactor only removes values it was told about, so "redact it and send a
 * short piece" is not the same guarantee as not sending it. This sends the
 * facts that are already the server's: which repository, which command, and
 * that it failed.
 */
export function failureSummary(
  failures: Array<{ repositoryName: string; result: VerificationResult }>
): string {
  const each = failures.map(
    ({ repositoryName, result }) =>
      `${repositoryName}: \`${result.command}\` exited with code ${result.exitCode ?? 'unknown'}`
  );
  return `${each.length} check${each.length === 1 ? '' : 's'} failed — ${each.join('; ')}.`;
}
