import { describe, expect, it } from 'vitest';
import { autoMergeCommand, isPullRequestUrl, rollUpChecks } from './github';

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

describe('autoMergeCommand', () => {
  const pr = (n: number) => `https://github.com/acme/api/pull/${n}`;

  it('asks GitHub to merge when checks pass, rather than merging anything itself', () => {
    const cmd = autoMergeCommand([pr(7)]);
    expect(cmd).toContain('gh pr merge');
    // --auto is the whole point: GitHub holds it until the checks are green.
    expect(cmd).toContain('--auto');
    expect(cmd).toContain('--squash');
    expect(cmd).toContain('--delete-branch');
  });

  it('asks for each pull request on its own', () => {
    // With several repositories, one repository refusing is not a reason to
    // leave the others waiting for a person who is not coming.
    const cmd = autoMergeCommand([pr(7), 'https://github.com/acme/web/pull/9']);
    expect(cmd.match(/gh pr merge/g)).toHaveLength(2);
    expect(cmd).toContain('acme/api #7');
    expect(cmd).toContain('acme/web #9');
  });

  it('says what to do when a repository has auto-merge switched off', () => {
    expect(autoMergeCommand([pr(7)])).toMatch(/would not arm auto-merge/);
    expect(autoMergeCommand([pr(7)])).toMatch(/merging it is yours/);
  });

  it('refuses anything that is not a pull request url', () => {
    // These reach a command line, so the guard is the same one the states read
    // uses — nothing else may get there.
    expect(autoMergeCommand(['https://github.com/acme/api/issues/7'])).toBe('');
    expect(autoMergeCommand(['; rm -rf /'])).toBe('');
    expect(autoMergeCommand([])).toBe('');
  });
});
