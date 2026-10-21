import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, ContractMismatchError } from './contract';
import {
  authorisedRepository,
  idempotencyKey,
  orderedItems,
  parseAssignment,
  validCloneUrl,
  validCommit,
  validId,
  validRef,
} from './validate';
import {
  featureAssignment,
  sameBasenameAssignment,
  standaloneStoryAssignment,
  standaloneTaskAssignment,
} from './fixtures';

describe('parseAssignment', () => {
  it('accepts the three shapes a worker is asked to build', () => {
    for (const make of [
      featureAssignment,
      standaloneStoryAssignment,
      standaloneTaskAssignment,
      sameBasenameAssignment,
    ]) {
      expect(() => parseAssignment(JSON.parse(JSON.stringify(make())))).not.toThrow();
    }
  });

  it('carries a standalone story’s own acceptance criteria', () => {
    // The point of the standalone case: no feature PRD stands between the
    // story and the work.
    const parsed = parseAssignment(JSON.parse(JSON.stringify(standaloneStoryAssignment())));
    expect(parsed.requirements.items).toHaveLength(0);
    expect(parsed.requirements.acceptanceCriteria.map((a) => a.text)).toContain(
      'An Export button appears on the invoices screen'
    );
  });

  it('refuses a contract version it does not speak', () => {
    const raw = { ...featureAssignment(), contractVersion: 'something.else/2020-01-01' };
    expect(() => parseAssignment(raw)).toThrow(ContractMismatchError);
  });

  it('refuses a clone URL that is not https or ssh', () => {
    // file:// and ext:: would make the server able to read the worker's disk
    // or run a command through git's transport helpers.
    for (const cloneUrl of [
      'file:///etc',
      'ext::sh -c whoami',
      '/var/lib/secrets',
      'http://insecure/repo.git',
    ]) {
      const raw = featureAssignment();
      raw.repositories[0].cloneUrl = cloneUrl;
      expect(() => parseAssignment(JSON.parse(JSON.stringify(raw)))).toThrow(/cloneUrl/);
    }
  });

  it('refuses a verification step pointed at an unauthorised repository', () => {
    // Otherwise the server picks a command AND the checkout it runs in.
    const raw = featureAssignment();
    raw.verification.steps[0].repositoryId = 'repo-somebody-elses';
    expect(() => parseAssignment(JSON.parse(JSON.stringify(raw)))).toThrow(/does not authorise/);
  });

  it('refuses a base branch that could escape its own argument', () => {
    for (const baseBranch of ['--upload-pack=sh', '../../main', 'main;rm -rf /']) {
      const raw = featureAssignment();
      raw.repositories[0].baseBranch = baseBranch;
      expect(() => parseAssignment(JSON.parse(JSON.stringify(raw)))).toThrow(/baseBranch/);
    }
  });

  it('refuses a repository id that is not path-safe', () => {
    // It becomes a directory name under the execution root.
    for (const repositoryId of ['../escape', 'a/b', '.hidden', '']) {
      const raw = featureAssignment();
      raw.repositories[0].repositoryId = repositoryId;
      expect(() => parseAssignment(JSON.parse(JSON.stringify(raw)))).toThrow();
    }
  });

  it('refuses two repositories sharing an id, and allows two sharing a name', () => {
    const dup = featureAssignment();
    dup.repositories[1].repositoryId = dup.repositories[0].repositoryId;
    expect(() => parseAssignment(JSON.parse(JSON.stringify(dup)))).toThrow(/repeats/);
    // Same basename is ordinary and must be accepted.
    expect(() =>
      parseAssignment(JSON.parse(JSON.stringify(sameBasenameAssignment())))
    ).not.toThrow();
  });

  it('names the field it refused, so the report says what to fix', () => {
    const raw = featureAssignment() as unknown as Record<string, unknown>;
    delete raw.executionId;
    expect(() => parseAssignment(raw)).toThrow(/assignment\.executionId/);
  });
});

describe('field guards', () => {
  it('knows a usable clone URL from an unusable one', () => {
    expect(validCloneUrl('https://github.com/acme/api.git')).toBe(true);
    expect(validCloneUrl('git@github.com:acme/api.git')).toBe(true);
    expect(validCloneUrl('ssh://git@github.com/acme/api.git')).toBe(true);
    expect(validCloneUrl('file:///etc/passwd')).toBe(false);
    expect(validCloneUrl('ext::sh -c id')).toBe(false);
  });

  it('knows a usable ref from one that would be read as a flag', () => {
    expect(validRef('main')).toBe(true);
    expect(validRef('mvpfy/exec-1')).toBe(true);
    expect(validRef('--upload-pack=x')).toBe(false);
    expect(validRef('a..b')).toBe(false);
    expect(validRef('trailing/')).toBe(false);
  });

  it('knows a commit sha', () => {
    expect(validCommit('a'.repeat(40))).toBe(true);
    expect(validCommit('abc1234')).toBe(true);
    expect(validCommit('HEAD')).toBe(false);
    expect(validCommit('')).toBe(false);
  });

  it('knows an id that is safe in a path', () => {
    expect(validId('repo-api')).toBe(true);
    expect(validId('../escape')).toBe(false);
    expect(validId('a/b')).toBe(false);
  });
});

describe('orderedItems', () => {
  it('puts a dependency before the item that needs it', () => {
    const ordered = orderedItems(featureAssignment());
    expect(ordered?.map((i) => i.id)).toEqual(['us-1', 'us-2']);
  });

  it('refuses a cycle rather than guessing an order', () => {
    const raw = featureAssignment();
    raw.requirements.items[0].dependsOn = ['us-2'];
    expect(orderedItems(raw)).toBeNull();
  });

  it('refuses a dependency on something not in the snapshot', () => {
    const raw = featureAssignment();
    raw.requirements.items[0].dependsOn = ['us-does-not-exist'];
    expect(orderedItems(raw)).toBeNull();
  });
});

describe('idempotencyKey', () => {
  it('is the same key for the same event, across restarts', () => {
    // Derived only from identity the worker still has after a restart —
    // no clock, no random value.
    const parts = { executionId: 'exec-1', attemptId: 'attempt-2', kind: 'result' };
    expect(idempotencyKey(parts)).toBe(idempotencyKey({ ...parts }));
    expect(idempotencyKey(parts)).toBe('exec-1:attempt-2:result');
  });

  it('separates attempts, so a retry of a stale attempt is not mistaken for the live one', () => {
    expect(idempotencyKey({ executionId: 'e', attemptId: '1', kind: 'result' })).not.toBe(
      idempotencyKey({ executionId: 'e', attemptId: '2', kind: 'result' })
    );
  });

  it('separates repositories within one execution', () => {
    const pr = (repo: string) =>
      idempotencyKey({ executionId: 'e', attemptId: '1', kind: 'attach_pr', discriminator: repo });
    expect(pr('repo-api')).not.toBe(pr('repo-web'));
  });
});

describe('authorisedRepository', () => {
  it('refuses a repository the assignment does not name', () => {
    expect(() => authorisedRepository(featureAssignment(), 'repo-elsewhere')).toThrow(
      /not authorised/
    );
  });

  it('returns the one it does', () => {
    expect(authorisedRepository(featureAssignment(), 'repo-api').name).toBe('api');
  });
});

describe('the contract version', () => {
  it('is carried by every fixture, so a bump breaks them loudly', () => {
    expect(featureAssignment().contractVersion).toBe(CONTRACT_VERSION);
  });
});
