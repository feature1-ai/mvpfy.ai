import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * A pull request as the worker records it.
 *
 * Richer than what Feature1 takes — it accepts a URL and resolves the rest
 * itself — because the worker has to recognise its own pull request on a
 * later attempt, and a URL alone does not say which repository or branch it
 * belongs to.
 */
export interface PullRequestRecord {
  url: string;
  number: number;
  repositoryOwner: string;
  repositoryName: string;
  headBranch: string;
  baseBranch: string;
  /** False when this attempt found an existing pull request and reused it. */
  createdByThisAttempt: boolean;
}
import { CommandRunner } from './exec';
import { posixQuote, parseGitHubRepo } from './git';
import { Redactor } from './redact';

/**
 * Opening exactly one pull request per repository per execution, however
 * many times the worker is interrupted and resumed.
 *
 * The desktop app learns a pull request's URL by reading it out of an agent's
 * log. That is fine with somebody watching and useless here: a push can
 * succeed while the response is lost, a worker can be killed between opening
 * a pull request and recording it, and in both cases the log is gone. So the
 * question "is there already a pull request for this work?" is asked of
 * GitHub, by repository and head branch — the two things that are still true
 * after a crash — and never of a log.
 *
 * Everything in this file therefore has to be safe to call twice.
 */

export interface PullRequestTarget {
  worktree: string;
  owner: string;
  name: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export class PullRequestError extends Error {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message);
    this.name = 'PullRequestError';
  }
}

export class PullRequests {
  constructor(
    private readonly runner: CommandRunner,
    private readonly redactor: Redactor,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private async gh(cwd: string, args: string, timeoutMs = 120_000) {
    return this.runner.run(`gh ${args}`, {
      cwd,
      env: { ...this.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      timeoutMs,
    });
  }

  /**
   * The pull request already open for this branch, if there is one.
   *
   * Asked by head branch rather than by URL. `--state all` on purpose: a
   * closed pull request for this branch still means the worker must not open
   * a second, and the caller is told rather than left to find out.
   */
  async findExisting(target: PullRequestTarget): Promise<PullRequestRecord | null> {
    const res = await this.gh(
      target.worktree,
      `pr list --repo ${posixQuote(`${target.owner}/${target.name}`)} ` +
        `--head ${posixQuote(target.headBranch)} --state all --limit 5 ` +
        `--json number,url,headRefName,baseRefName,state`
    );
    if (res.code !== 0) return null;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = JSON.parse(res.stdout.trim() || '[]');
    } catch {
      return null;
    }
    // Matched on the branch again here, not just trusted from the query: a
    // wrong pull request attached to an artifact is worse than none.
    const row = rows.find((r) => String(r.headRefName ?? '') === target.headBranch);
    if (!row) return null;
    const number = Number(row.number);
    const url = String(row.url ?? '');
    if (!Number.isFinite(number) || !/^https:\/\/github\.com\//.test(url)) return null;
    return {
      url,
      number,
      repositoryOwner: target.owner,
      repositoryName: target.name,
      headBranch: target.headBranch,
      baseBranch: String(row.baseRefName ?? target.baseBranch),
      createdByThisAttempt: false,
    };
  }

  /**
   * One pull request for this branch, created only if there is not one.
   *
   * The create is still attempted when the lookup found nothing, and a
   * failure is re-checked rather than believed: between looking and creating,
   * another attempt of the same execution may have opened one, and GitHub
   * refusing with "already exists" is then the correct outcome rather than an
   * error worth reporting.
   */
  async ensure(target: PullRequestTarget): Promise<PullRequestRecord> {
    const existing = await this.findExisting(target);
    if (existing) return existing;

    const bodyFile = path.join(target.worktree, '.mvpfy-pr-body.md');
    // The body is written through the redactor: it is the most public thing
    // the worker produces, and an agent that pasted a token into its summary
    // must not have it published.
    fs.writeFileSync(bodyFile, this.redactor.redact(target.body), 'utf8');
    try {
      const res = await this.gh(
        target.worktree,
        `pr create --repo ${posixQuote(`${target.owner}/${target.name}`)} ` +
          `--base ${posixQuote(target.baseBranch)} --head ${posixQuote(target.headBranch)} ` +
          `--title ${posixQuote(target.title.replace(/\s+/g, ' ').trim())} ` +
          `--body-file ${posixQuote(bodyFile)}`
      );
      if (res.code === 0) {
        // Read it back rather than parsing the create output: what matters is
        // what GitHub now holds, and that is the same question as before.
        const made = await this.findExisting(target);
        if (made) return { ...made, createdByThisAttempt: true };
      }
      // Creating failed, or succeeded in a way we could not read. Either way
      // the only safe next move is to look again.
      const afterward = await this.findExisting(target);
      if (afterward) return afterward;
      throw new PullRequestError(
        `Could not open a pull request for ${target.owner}/${target.name}`,
        this.redactor.line(res.stderr || res.stdout)
      );
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }
  }

  /** The repository GitHub knows, from the checkout's own origin. */
  static repoFrom(originUrl: string): { owner: string; name: string } | null {
    return parseGitHubRepo(originUrl);
  }
}

/**
 * The body of a worker's pull request.
 *
 * Says what it built and what it checked, names the execution so a reviewer
 * can find it in Feature1, and contains no credential and no log. The
 * verification table is the point: a reviewer should be able to see at a
 * glance what ran and what did not, rather than taking "the agent finished"
 * as evidence.
 */
export function pullRequestBody(input: {
  artifactCode?: string;
  artifactTitle: string;
  executionId: string;
  requirementsRevision: string;
  acceptanceCriteria: Array<{ id: string; text: string }>;
  verification: Array<{ name: string; outcome: string; reason?: string }>;
}): string {
  const criteria = input.acceptanceCriteria.length
    ? input.acceptanceCriteria.map((ac) => `- ${ac.text}`).join('\n')
    : '_None recorded on the assignment._';
  const checks = input.verification.length
    ? input.verification
        .map((v) => `| ${v.name} | ${v.outcome} | ${v.reason ? v.reason : ''} |`)
        .join('\n')
    : '| — | nothing was verified | |';
  const heading = input.artifactCode
    ? `${input.artifactCode} — ${input.artifactTitle}`
    : input.artifactTitle;
  return [
    `## ${heading}`,
    '',
    'Built by a mvpfy worker. Nothing here has been merged or marked done.',
    '',
    '### Acceptance criteria',
    criteria,
    '',
    '### Verification',
    '',
    '| Check | Outcome | Note |',
    '| --- | --- | --- |',
    checks,
    '',
    `<sub>execution \`${input.executionId}\` · requirements \`${input.requirementsRevision}\`</sub>`,
    '',
  ].join('\n');
}
