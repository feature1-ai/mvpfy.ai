import { describe, expect, it } from 'vitest';
import { isPullRequestUrl, rollUpChecks } from './github';

describe('isPullRequestUrl', () => {
  it('accepts a pull request url and nothing else', () => {
    // These reach a command line, so anything that is not plainly a PR URL is
    // refused before gh ever sees it.
    expect(isPullRequestUrl('https://github.com/acme/app/pull/12')).toBe(true);
    expect(isPullRequestUrl('https://github.example.com/acme/app/pull/3')).toBe(true);
    expect(isPullRequestUrl('https://github.com/acme/app/issues/12')).toBe(false);
    expect(isPullRequestUrl('https://github.com/acme/app/pull/12 && rm -rf /')).toBe(false);
    expect(isPullRequestUrl('http://github.com/acme/app/pull/12')).toBe(false);
    expect(isPullRequestUrl('')).toBe(false);
  });
});

describe('rollUpChecks', () => {
  const check = (status: string, conclusion: string) => ({ status, conclusion });

  it('is passing only when every check has finished and none failed', () => {
    expect(rollUpChecks([check('COMPLETED', 'SUCCESS'), check('COMPLETED', 'SKIPPED')])).toBe(
      'passing'
    );
  });

  it('is failing on one red check, whatever the others say', () => {
    // A single failure is the answer — the rest cannot make it green.
    expect(rollUpChecks([check('COMPLETED', 'SUCCESS'), check('COMPLETED', 'FAILURE')])).toBe(
      'failing'
    );
    expect(rollUpChecks([check('COMPLETED', 'TIMED_OUT')])).toBe('failing');
    expect(rollUpChecks([check('COMPLETED', 'CANCELLED')])).toBe('failing');
  });

  it('is pending while anything is still running', () => {
    expect(rollUpChecks([check('IN_PROGRESS', ''), check('COMPLETED', 'SUCCESS')])).toBe('pending');
    expect(rollUpChecks([check('QUEUED', '')])).toBe('pending');
  });

  it('reads an older commit status, which reports state instead', () => {
    expect(rollUpChecks([{ state: 'SUCCESS' }])).toBe('passing');
    expect(rollUpChecks([{ state: 'FAILURE' }])).toBe('failing');
  });

  it('says none rather than passing when there are no checks at all', () => {
    // "Passing" would claim something was verified when nothing ran.
    expect(rollUpChecks([])).toBe('none');
    expect(rollUpChecks(null)).toBe('none');
  });
});
