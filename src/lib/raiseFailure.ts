/**
 * What went wrong raising a pull request, in words the builder can act on.
 *
 * git and gh explain themselves to engineers. The same failures said plainly —
 * and, where mvpfy can repair them itself, offered as a button — are the
 * difference between a dead end and a next step.
 */
export interface RaiseFailure {
  /** What is true, in one sentence. */
  title: string;
  /** What to do about it. */
  fix: string;
  /** mvpfy can run the repair itself. */
  repairable?: boolean;
}

/** The first rule whose pattern appears wins, so order is by specificity. */
const RULES: Array<{ test: RegExp; explain: () => RaiseFailure }> = [
  {
    // gh can be signed in while git itself still has no credentials: the
    // credential helper is wired by `gh auth setup-git`, which a sign-in done
    // by hand may never have run.
    test: /could not read (Username|Password)|Authentication failed|terminal prompts disabled|no credential helper|Permission denied \(publickey\)/i,
    explain: () => ({
      title: 'Git could not prove who you are to GitHub.',
      fix: 'Being signed in to the GitHub CLI is not enough on its own — git needs to be told to use it. mvpfy can do that now.',
      repairable: true,
    }),
  },
  {
    test: /protected branch|refusing to allow|GH006|not authorized|403|Resource not accessible/i,
    explain: () => ({
      title: 'GitHub refused the push.',
      fix: 'The account you are signed in as does not have permission to push to this repository, or a branch rule is blocking it. Ask for write access, or fork the repository and point the remote at your fork.',
    }),
  },
  {
    test: /Repository not found|remote: Not Found|does not appear to be a git repository|No such remote/i,
    explain: () => ({
      title: 'GitHub could not find the repository this project points at.',
      fix: 'Check the remote — `git remote -v` in the project folder should name a repository you can reach. A private repository you are not a member of looks exactly like one that does not exist.',
    }),
  },
  {
    test: /non-fast-forward|fetch first|rejected.*\(fetch first\)|behind its remote/i,
    explain: () => ({
      title: 'The branch on GitHub has commits this one does not.',
      fix: 'Someone, or something, pushed to the same branch. Pull those commits in first: `git pull --rebase` in the project folder, then raise again.',
    }),
  },
  {
    test: /No commits between/i,
    explain: () => ({
      title: 'There is nothing to review.',
      fix: 'The branch has no commits the default branch does not, so GitHub will not open a pull request. Implement a story — moving one to Done by hand writes no code.',
    }),
  },
  {
    test: /a pull request for branch .* already exists|already exists/i,
    explain: () => ({
      title: 'A pull request for this branch is already open.',
      fix: 'Nothing more is needed — pushing has updated it. Open it on GitHub to see the new commits.',
    }),
  },
  {
    test: /could not resolve host|network is unreachable|Connection refused|timed out/i,
    explain: () => ({
      title: 'GitHub could not be reached.',
      fix: 'Check your connection and try again; nothing has been lost.',
    }),
  },
];

export function explainRaiseFailure(log: string | null | undefined): RaiseFailure | null {
  const text = log ?? '';
  if (!text.trim()) return null;
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.explain();
  }
  return null;
}
