import { PullRequestState } from '../../shared/types';
import { shellQuote, spawnShellSync } from './shell';

/**
 * What GitHub says about the pull requests mvpfy raised.
 *
 * Asked of gh rather than remembered, because everything interesting here
 * happens after mvpfy's part is finished: a check goes red an hour later,
 * somebody asks for changes overnight, it merges while nobody is looking. A
 * stored answer is out of date the moment it is written.
 */

/** A GitHub pull request URL, and nothing else — these reach a command line. */
export function isPullRequestUrl(value: string): boolean {
  return /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(value.trim());
}

/** Roll every check up into the one word a person needs. */
export function rollUpChecks(rollup: unknown): PullRequestState['checks'] {
  const rows = Array.isArray(rollup) ? (rollup as Array<Record<string, unknown>>) : [];
  if (rows.length === 0) return 'none';
  let pending = false;
  for (const row of rows) {
    // Checks report status/conclusion; older commit statuses report state.
    const status = String(row.status ?? '').toUpperCase();
    const conclusion = String(row.conclusion ?? row.state ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      pending = true;
      continue;
    }
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR'].includes(conclusion)) {
      // One red check is the answer; the rest cannot make it green.
      return 'failing';
    }
    if (conclusion === 'PENDING' || conclusion === '') pending = true;
  }
  return pending ? 'pending' : 'passing';
}

export function pullRequestStates(urls: string[]): PullRequestState[] {
  const out: PullRequestState[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    const blank: PullRequestState = {
      url,
      number: 0,
      title: '',
      state: '',
      isDraft: false,
      checks: 'none',
      reviewDecision: '',
    };
    if (!isPullRequestUrl(url)) {
      out.push({ ...blank, error: 'Not a pull request URL' });
      continue;
    }
    const res = spawnShellSync(
      `gh pr view ${shellQuote(url)} --json number,state,isDraft,title,reviewDecision,statusCheckRollup`,
      { encoding: 'utf8', timeout: 30_000 }
    );
    if (res.status !== 0) {
      // Not signed in, no access, or GitHub is down. Saying which beats an
      // empty row that reads as "nothing is happening".
      out.push({
        ...blank,
        error: (res.stderr || res.stdout || '').trim().split('\n')[0] || 'gh could not read it',
      });
      continue;
    }
    try {
      const d = JSON.parse(res.stdout) as Record<string, unknown>;
      out.push({
        url,
        number: Number(d.number) || 0,
        title: String(d.title ?? ''),
        state: String(d.state ?? '').toUpperCase(),
        isDraft: d.isDraft === true,
        checks: rollUpChecks(d.statusCheckRollup),
        reviewDecision: String(d.reviewDecision ?? '').toUpperCase(),
      });
    } catch {
      out.push({ ...blank, error: 'gh answered something unreadable' });
    }
  }
  return out;
}

/**
 * Ask GitHub to merge these pull requests itself, once their checks pass.
 *
 * For a builder with nobody to review: the pull request is still raised, still
 * runs its checks, still exists to be read — it simply does not wait for a
 * reviewer who is never coming. GitHub holds it and merges when the checks are
 * green, which is the part that matters: nothing here merges anything, and a
 * red check leaves the pull request open exactly as it would have been.
 *
 * Squash, because a feature is one change to the product however many stories
 * it took, and the pull request body already lists them.
 *
 * Each pull request is asked for on its own: with several repositories, one
 * refusing is not a reason to leave the others waiting for a person. A refusal
 * is reported rather than worked around — the usual one is a repository that
 * has not turned auto-merge on, and merging it immediately instead would be
 * the one thing this must never do.
 */
export function autoMergeCommand(urls: string[]): string {
  const steps: string[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    // Never a string from anywhere else: these reach a command line.
    if (!isPullRequestUrl(url)) continue;
    const q = shellQuote(url);
    const name = url.replace(/^https:\/\/[^/]+\//, '').replace('/pull/', ' #');
    steps.push(
      `(echo ${shellQuote(`── ${name}`)} && gh pr merge ${q} --squash --auto --delete-branch) || ` +
        `echo ${shellQuote(
          `${name}: GitHub would not arm auto-merge — usually because the repository has it switched off (Settings → General → Pull Requests). The pull request is open and merging it is yours`
        )}`
    );
  }
  if (steps.length === 0) return '';
  return steps.join(' && ');
}
