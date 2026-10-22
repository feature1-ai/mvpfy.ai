import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, ProtocolMismatchError, RepositoryResult } from './contract';
import {
  authorisedRepository,
  parseExecution,
  passingTests,
  repositoryResultProblem,
  unitsOf,
  validCloneUrl,
  validCommit,
  validPullRequestUrl,
  validRef,
  validUuid,
} from './validate';
import {
  IDS,
  featureExecution,
  sameNameExecution,
  standaloneStoryExecution,
  standaloneTaskExecution,
} from './fixtures';

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('parseExecution', () => {
  it('accepts the shapes Feature1 actually sends', () => {
    for (const make of [
      featureExecution,
      standaloneStoryExecution,
      standaloneTaskExecution,
      sameNameExecution,
    ]) {
      expect(() => parseExecution(roundTrip(make()))).not.toThrow();
    }
  });

  it('refuses a protocol version it does not speak', () => {
    // The server sends protocol_version on every claim precisely so this
    // can be checked before anything is cloned.
    expect(() => parseExecution({ ...featureExecution(), protocol_version: 2 })).toThrow(
      ProtocolMismatchError
    );
    expect(() => parseExecution({ ...featureExecution(), protocol_version: undefined })).toThrow(
      ProtocolMismatchError
    );
  });

  it('carries a standalone story’s own criteria, with no feature wrapper', () => {
    const parsed = parseExecution(roundTrip(standaloneStoryExecution()));
    expect(parsed.snapshot.stories).toBeUndefined();
    expect(unitsOf(parsed)).toHaveLength(1);
    expect(unitsOf(parsed)[0].id).toBe(IDS.standaloneStory);
  });

  it('keeps a feature’s stories in the order Feature1 sent them', () => {
    // Feature1 filters finished children and orders by generation order, so
    // there is no dependency graph for the worker to solve.
    const parsed = parseExecution(roundTrip(featureExecution()));
    expect(unitsOf(parsed).map((s) => s.code)).toEqual(['US-01', 'US-02']);
  });

  it('refuses a repository URL that is not a credential-free git URL', () => {
    for (const url of [
      'file:///etc',
      'ext::sh -c id',
      'http://insecure/repo.git',
      'https://user:pw@github.com/acme/api.git',
    ]) {
      const raw = featureExecution();
      raw.repositories[0].url = url;
      expect(() => parseExecution(roundTrip(raw))).toThrow(/url/);
    }
  });

  it('refuses a base branch that could be read as a flag', () => {
    for (const branch of ['--upload-pack=sh', '../../main', 'main;rm -rf /', 'trailing/']) {
      const raw = featureExecution();
      raw.repositories[0].base_branch = branch;
      expect(() => parseExecution(roundTrip(raw))).toThrow(/base_branch/);
    }
  });

  it('insists every identifier is a UUID, because they become directories', () => {
    for (const bad of ['../escape', 'repo-api', '']) {
      const raw = featureExecution();
      raw.repositories[0].id = bad;
      expect(() => parseExecution(roundTrip(raw))).toThrow();
    }
  });

  it('allows two repositories with the same name and different ids', () => {
    const parsed = parseExecution(roundTrip(sameNameExecution()));
    expect(parsed.repositories.map((r) => r.name)).toEqual(['api', 'api']);
    expect(new Set(parsed.repositories.map((r) => r.id)).size).toBe(2);
  });

  it('drops a carried-over result for a repository the execution does not hold', () => {
    // Acting on it would mean reporting about something unauthorised.
    const raw = featureExecution();
    raw.results = {
      'not-in-this-run': {
        outcome: 'pr_created',
        tests: [],
        base_commit: '',
        head_commit: '',
        pr_urls: [],
      },
    } as never;
    expect(Object.keys(parseExecution(roundTrip(raw)).results)).toEqual([]);
  });

  it('keeps results a previous attempt already reported', () => {
    const raw = featureExecution();
    raw.results = {
      [IDS.repoApi]: {
        outcome: 'pr_created',
        tests: [{ command: 'npm test', exit_code: 0 }],
        base_commit: 'a'.repeat(40),
        head_commit: 'b'.repeat(40),
        pr_urls: ['https://github.com/acme/api/pull/7'],
        attempt: 1,
      },
    };
    expect(parseExecution(roundTrip(raw)).results[IDS.repoApi].outcome).toBe('pr_created');
  });

  it('names the field it refused, so the failure says what to fix', () => {
    const raw = featureExecution() as unknown as Record<string, unknown>;
    delete raw.lease_token;
    expect(() => parseExecution(raw)).toThrow(/lease_token/);
  });
});

describe('field guards', () => {
  it('knows a usable git URL from an unusable one', () => {
    expect(validCloneUrl('https://github.com/acme/api.git')).toBe(true);
    expect(validCloneUrl('git@github.com:acme/api.git')).toBe(true);
    expect(validCloneUrl('ssh://git@github.com/acme/api.git')).toBe(true);
    // Feature1 refuses to register a URL with credentials in it, and the
    // worker refuses to use one: it would end up in a process list.
    expect(validCloneUrl('https://user:pw@github.com/acme/api.git')).toBe(false);
    expect(validCloneUrl('file:///etc/passwd')).toBe(false);
  });

  it('matches Feature1’s own idea of a base branch', () => {
    expect(validRef('main')).toBe(true);
    expect(validRef('release/2026-10')).toBe(true);
    expect(validRef('a..b')).toBe(false);
    expect(validRef('x/')).toBe(false);
  });

  it('knows a commit sha the server will accept', () => {
    expect(validCommit('a'.repeat(40))).toBe(true);
    expect(validCommit('a'.repeat(64))).toBe(true);
    // The server's floor is 40; an abbreviated sha is rejected there.
    expect(validCommit('abc1234')).toBe(false);
    expect(validCommit('HEAD')).toBe(false);
  });

  it('knows a UUID', () => {
    expect(validUuid(IDS.repoApi)).toBe(true);
    expect(validUuid('repo-api')).toBe(false);
  });

  it('matches the pull request URLs Feature1 parses', () => {
    expect(validPullRequestUrl('https://github.com/acme/api/pull/12')).toBe(true);
    // Enterprise hosts are fine; ports, credentials and other paths are not.
    expect(validPullRequestUrl('https://git.acme.com/acme/api/pull/12')).toBe(true);
    expect(validPullRequestUrl('http://github.com/acme/api/pull/12')).toBe(false);
    expect(validPullRequestUrl('https://github.com:8443/acme/api/pull/12')).toBe(false);
    expect(validPullRequestUrl('https://github.com/acme/api/pulls/12')).toBe(false);
    expect(validPullRequestUrl('https://github.com/acme/api/pull/0')).toBe(false);
  });
});

describe('repositoryResultProblem', () => {
  const good = (): RepositoryResult => ({
    repository_id: IDS.repoApi,
    outcome: 'pr_created',
    base_commit: 'a'.repeat(40),
    head_commit: 'b'.repeat(40),
    tests: [{ command: 'npm test', exit_code: 0 }],
    pr_urls: ['https://github.com/acme/api/pull/7'],
  });

  it('passes a well-formed result', () => {
    expect(repositoryResultProblem(good())).toBeNull();
  });

  it('refuses a result carrying a check that failed', () => {
    // The strictest rule on the server, and the one that shapes the whole
    // worker: there is no way to hand over a repository whose tests failed.
    const result = good();
    result.tests = [{ command: 'npm test', exit_code: 1 }];
    expect(repositoryResultProblem(result)).toMatch(/only passing/);
  });

  it('refuses a result with no checks at all', () => {
    const result = good();
    result.tests = [];
    expect(repositoryResultProblem(result)).toMatch(/between 1 and 100/);
  });

  it('holds no_changes to identical commits and no pull requests', () => {
    const result = good();
    result.outcome = 'no_changes';
    expect(repositoryResultProblem(result)).toMatch(/cannot carry pull request/);
    result.pr_urls = [];
    expect(repositoryResultProblem(result)).toMatch(/identical base and head/);
    result.head_commit = result.base_commit;
    expect(repositoryResultProblem(result)).toBeNull();
  });

  it('insists pr_created carries a pull request', () => {
    const result = good();
    result.pr_urls = [];
    expect(repositoryResultProblem(result)).toMatch(/at least one pull request/);
  });

  it('refuses an abbreviated commit sha', () => {
    const result = good();
    result.base_commit = 'abc1234';
    expect(repositoryResultProblem(result)).toMatch(/40–64 hex/);
  });
});

describe('passingTests', () => {
  it('sends only what passed, because nothing else is accepted', () => {
    expect(
      passingTests([
        { command: 'npm test', exitCode: 0 },
        { command: 'npm run lint', exitCode: 1 },
        { command: 'npm run build', exitCode: null },
      ])
    ).toEqual([{ command: 'npm test', exit_code: 0 }]);
  });

  it('bounds a command to the length the server allows', () => {
    const [record] = passingTests([{ command: 'x'.repeat(2000), exitCode: 0 }]);
    expect(record.command.length).toBe(1000);
  });
});

describe('authorisedRepository', () => {
  it('refuses a repository the execution does not hold', () => {
    expect(() => authorisedRepository(featureExecution(), IDS.repoBillingApi)).toThrow(
      /not part of execution/
    );
  });

  it('returns the one it does', () => {
    expect(authorisedRepository(featureExecution(), IDS.repoApi).name).toBe('api');
  });
});

describe('the protocol version', () => {
  it('is 1, and every fixture carries it', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(featureExecution().protocol_version).toBe(1);
  });
});
