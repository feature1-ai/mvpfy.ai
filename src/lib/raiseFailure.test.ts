import { describe, expect, it } from 'vitest';
import { explainRaiseFailure } from './raiseFailure';

describe('explainRaiseFailure', () => {
  it('spots git having no credentials, which gh being signed in does not fix', () => {
    // The commonest cause, and the only one mvpfy can repair itself.
    const out = explainRaiseFailure('fatal: could not read Username for https://github.com');
    expect(out?.repairable).toBe(true);
    expect(out?.title).toMatch(/could not prove who you are/i);
  });

  it('spots a push GitHub refused, and does not offer to repair it', () => {
    const out = explainRaiseFailure('remote: error: GH006: Protected branch update failed');
    expect(out?.title).toMatch(/refused the push/i);
    expect(out?.repairable).toBeUndefined();
  });

  it('tells a missing repository from a private one, because they look alike', () => {
    expect(explainRaiseFailure('remote: Repository not found.')?.fix).toMatch(
      /private repository/i
    );
  });

  it('spots a branch that has moved on, and says how to catch up', () => {
    expect(explainRaiseFailure('! [rejected] main -> main (fetch first)')?.fix).toMatch(
      /git pull --rebase/
    );
  });

  it('explains an empty pull request as work never done, not a fault', () => {
    const out = explainRaiseFailure('GraphQL: No commits between main and mvpfy/x');
    expect(out?.fix).toMatch(/moving one to Done by hand writes no code/i);
  });

  it('treats an existing pull request as nothing to do', () => {
    expect(
      explainRaiseFailure('a pull request for branch "mvpfy/x" already exists')?.title
    ).toMatch(/already open/i);
  });

  it('prefers the credential rule over the permission one when both could match', () => {
    // "Authentication failed" and "403" often appear together; the fixable
    // reading is the more useful of the two.
    const out = explainRaiseFailure('remote: Authentication failed\nremote: HTTP 403');
    expect(out?.repairable).toBe(true);
  });

  it('says nothing rather than guessing at output it does not recognise', () => {
    expect(explainRaiseFailure('some unfamiliar failure')).toBeNull();
    expect(explainRaiseFailure('')).toBeNull();
    expect(explainRaiseFailure(null)).toBeNull();
  });
});
