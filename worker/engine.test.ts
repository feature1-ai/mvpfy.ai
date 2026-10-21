import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StaleAttemptError } from '../shared/runner/contract';
import {
  featureAssignment,
  sameBasenameAssignment,
  standaloneStoryAssignment,
  standaloneTaskAssignment,
} from '../shared/runner/fixtures';
import { Harness, agentChanges, makeHarness } from './harness';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

const never = new AbortController().signal;

describe('a feature with two stories across two repositories', () => {
  it('builds each story, verifies, and opens one pull request per changed repository', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api', 'repo-web');
    h.transport.offer(assignment);

    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);

    expect(outcome).toBe('ready_for_testing');
    // One agent run per story, in dependency order.
    expect(h.agent.runs).toHaveLength(2);
    expect(h.agent.runs[0].prompt).toContain('US-01');
    expect(h.agent.runs[1].prompt).toContain('US-02');
    // One pull request per repository, never two for one.
    expect(h.prs.creates.sort()).toEqual([
      'acme/repo-api#mvpfy/exec-feature-1',
      'acme/repo-web#mvpfy/exec-feature-1',
    ]);
    const result = h.transport.resultCalls.at(-1);
    expect(result?.outcome).toBe('ready_for_testing');
    expect(result?.repositories.filter((r) => r.pullRequest)).toHaveLength(2);
    expect(result?.requirementsRevision).toBe('rev-3');
  });

  it('walks the states in order, and says something a person can read', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(h.transport.progressCalls.map((p) => p.state)).toEqual([
      'preparing',
      'implementing',
      'verifying',
      'opening_prs',
    ]);
    expect(h.transport.progressCalls[1].detail).toMatch(/Building US-01.*1 of 2/);
  });

  it('attaches each pull request to the artifact Feature1 named', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api', 'repo-web');
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(h.transport.attachCalls).toHaveLength(2);
    for (const call of h.transport.attachCalls) {
      // Explicit ids, never a shared "current workflow".
      expect(call.expectedOwner).toEqual({ type: 'feature', id: 'fea-142' });
      expect(call.originArtifact.id).toBe('fea-142');
      expect(call.executionId).toBe('exec-feature-1');
    }
    // One key per repository, so neither overwrites the other on a retry.
    expect(new Set(h.transport.attachCalls.map((c) => c.idempotencyKey)).size).toBe(2);
  });

  it('reports a conflict when Feature1 attached it somewhere else', async () => {
    // Silently hanging a pull request off the wrong artifact is the kind of
    // mistake nobody finds for weeks.
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    h.transport.attachOverride.set('exec-feature-1', { type: 'story', id: 'some-other-story' });
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('failed');
    const failed = h.transport.resultCalls.at(-1)?.repositories.find((r) => r.error);
    expect(failed?.error).toMatch(/attached .* to story some-other-story/);
  });
});

describe('a standalone story', () => {
  it('builds directly from its own criteria, with no feature document', async () => {
    const assignment = standaloneStoryAssignment();
    agentChanges(h, 'repo-api');
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    // Nothing to discover in an empty checkout, which is reported rather
    // than treated as a failure.
    expect(outcome).toBe('ready_for_testing');
    expect(h.transport.resultCalls.at(-1)?.summary).toMatch(/not everything could be checked/);
    expect(h.agent.runs).toHaveLength(1);
    expect(h.agent.runs[0].prompt).toContain('An Export button appears on the invoices screen');
    expect(h.agent.runs[0].prompt).toMatch(/There is no feature document to write/);
    expect(h.transport.attachCalls[0].expectedOwner).toEqual({ type: 'story', id: 'sto-9' });
  });
});

describe('a standalone task', () => {
  it('is given its steps as instructions rather than a brief', async () => {
    const assignment = standaloneTaskAssignment();
    agentChanges(h, 'repo-api');
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    const prompt = h.agent.runs[0].prompt;
    expect(prompt).toContain('1. Bump the dependency');
    expect(prompt).toMatch(/A task is instructions, not a brief/);
    expect(h.transport.attachCalls[0].expectedOwner).toEqual({ type: 'task', id: 'tsk-4' });
  });
});

describe('two repositories with the same name', () => {
  it('keeps their checkouts, pushes and pull requests apart', async () => {
    const assignment = sameBasenameAssignment();
    agentChanges(h, 'repo-billing-api', 'repo-orders-api');
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(h.prs.creates.sort()).toEqual([
      'acme/repo-billing-api#mvpfy/exec-same-1',
      'acme/repo-orders-api#mvpfy/exec-same-1',
    ]);
    expect(new Set(h.git.pushes.map((p) => p.dir)).size).toBe(2);
  });
});

describe('a repository the agent did not touch', () => {
  it('is reported as unchanged, which is not a failure', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api'); // repo-web untouched
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('ready_for_testing');
    const web = h.transport.resultCalls
      .at(-1)
      ?.repositories.find((r) => r.repositoryId === 'repo-web');
    expect(web?.changed).toBe(false);
    expect(web?.pullRequest).toBeNull();
    expect(web?.error).toBeUndefined();
    expect(h.prs.creates).toHaveLength(1);
  });
});

describe('verification', () => {
  it('does not call an execution ready when a check failed', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api', 'repo-web');
    h.runner.when(/npm test/, { code: 1, stderr: '3 failing' });
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('failed');
    // The work is still published: the branch and pull request exist either
    // way, and a reviewer needs to see what failed.
    expect(h.prs.creates).toHaveLength(2);
    expect(h.transport.resultCalls.at(-1)?.summary).toMatch(/checks failed/);
  });

  it('says a check could not run, without calling the work a failure', async () => {
    // Nothing failed — there was nothing to run. Reporting `failed` would
    // state something untrue about work that may be perfectly good, and
    // would make the worker useless on any repository with no suite. The
    // summary and the per-step reason carry the truth instead.
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api', 'repo-web');
    h.runner.when(/npm test/, { code: 127, stderr: 'npm: not found' });
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('ready_for_testing');
    const result = h.transport.resultCalls.at(-1);
    expect(result?.summary).toMatch(/not everything could be checked/);
    const rows = result?.repositories[0].verification ?? [];
    expect(rows[0].outcome).toBe('unavailable');
    expect(rows[0].reason).toMatch(/not found/);
  });
});

describe('partial failure across repositories', () => {
  it('keeps the pull request that succeeded and names the one that did not', async () => {
    // Reporting the whole execution as failed would throw away real work.
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api', 'repo-web');
    h.git.failPush.add('repo-web');
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);

    expect(outcome).toBe('failed');
    const repos = h.transport.resultCalls.at(-1)?.repositories ?? [];
    const api = repos.find((r) => r.repositoryId === 'repo-api');
    const web = repos.find((r) => r.repositoryId === 'repo-web');
    expect(api?.pullRequest?.url).toMatch(/pull\/\d+/);
    expect(api?.error).toBeUndefined();
    expect(web?.pullRequest).toBeNull();
    expect(web?.error).toMatch(/remote rejected the push/);
  });

  it('asks a question when not one repository could be cloned', async () => {
    const assignment = featureAssignment();
    h.git.unclonable.add('repo-api');
    h.git.unclonable.add('repo-web');
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('blocked');
    expect(h.transport.blockedCalls[0].questions[0].kind).toBe('repository_unavailable');
  });
});

describe('blocked', () => {
  it('turns the agent’s questions into a blocked execution rather than a stall', async () => {
    const assignment = featureAssignment();
    h.agent.outcomes = [{ questions: ['Which payment provider should this use?'] }];
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('blocked');
    expect(h.transport.blockedCalls[0].questions[0].text).toBe(
      'Which payment provider should this use?'
    );
    // Nothing is published from a blocked execution.
    expect(h.prs.creates).toHaveLength(0);
  });

  it('asks rather than guessing when the stories cannot be ordered', async () => {
    const assignment = featureAssignment();
    assignment.requirements.items[0].dependsOn = ['us-2'];
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('blocked');
    expect(h.transport.blockedCalls[0].questions[0].kind).toBe('requirements_unclear');
  });
});

describe('cancellation', () => {
  it('stops and reports cancelled rather than finishing quietly', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    const controller = new AbortController();
    h.agent.onRun = () => controller.abort();
    const outcome = await h.engine.run(
      h.checkpoint(assignment),
      h.lease(assignment),
      controller.signal
    );
    expect(outcome).toBe('cancelled');
    expect(h.prs.creates).toHaveLength(0);
    expect(h.transport.resultCalls.at(-1)?.outcome).toBe('cancelled');
  });
});

describe('a lost lease', () => {
  it('stops before publishing and reports nothing', async () => {
    // The worst outcome this guards against: two workers both reporting.
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    const lease = h.lease(assignment, '2026-10-21T12:00:00.000Z');
    h.agent.onRun = () => h.setNow('2026-10-21T13:00:00.000Z');

    await expect(h.engine.run(h.checkpoint(assignment), lease, never)).rejects.toBeInstanceOf(
      StaleAttemptError
    );

    expect(h.git.pushes).toHaveLength(0);
    expect(h.prs.creates).toHaveLength(0);
    expect(h.transport.resultCalls).toHaveLength(0);
  });

  it('leaves the local work on disk', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    const lease = h.lease(assignment, '2026-10-21T12:00:00.000Z');
    h.agent.onRun = () => h.setNow('2026-10-21T13:00:00.000Z');
    await h.engine.run(h.checkpoint(assignment), lease, never).catch(() => undefined);
    const saved = h.store.load('acme', 'exec-feature-1');
    expect(saved).not.toBeNull();
    expect(saved?.reported).toBe(false);
  });

  it('refuses to report under an attempt the server has superseded', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    h.transport.offer(assignment);
    h.transport.supersede('exec-feature-1', 'token-2');
    // The lease has not expired locally, but the server knows better.
    await expect(
      h.engine.run(h.checkpoint(assignment), h.lease(assignment), never)
    ).rejects.toBeInstanceOf(StaleAttemptError);
  });
});

describe('restart recovery', () => {
  it('resumes without redoing a story it already built', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    const checkpoint = h.checkpoint(assignment);
    checkpoint.completedItems = ['us-1'];
    h.store.save(checkpoint);

    await h.engine.run(checkpoint, h.lease(assignment), never);
    expect(h.agent.runs).toHaveLength(1);
    expect(h.agent.runs[0].prompt).toContain('US-02');
  });

  it('reuses the pull request a previous run already opened', async () => {
    // The whole point of writing it down the moment it exists.
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    const checkpoint = h.checkpoint(assignment);
    const api = checkpoint.repositories[0];
    api.changed = true;
    api.pushed = true;
    api.pullRequest = {
      url: 'https://github.com/acme/repo-api/pull/7',
      number: 7,
      repositoryOwner: 'acme',
      repositoryName: 'repo-api',
      headBranch: 'mvpfy/exec-feature-1',
      baseBranch: 'main',
      createdByThisAttempt: false,
    };
    h.prs.open.set('acme/repo-api#mvpfy/exec-feature-1', api.pullRequest);
    h.store.save(checkpoint);

    await h.engine.run(checkpoint, h.lease(assignment), never);
    expect(h.prs.creates).toHaveLength(0);
    const reported = h.transport.resultCalls
      .at(-1)
      ?.repositories.find((r) => r.repositoryId === 'repo-api');
    expect(reported?.pullRequest?.number).toBe(7);
  });

  it('does not push twice when the first run already pushed', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    const checkpoint = h.checkpoint(assignment);
    checkpoint.repositories[0].changed = true;
    checkpoint.repositories[0].pushed = true;
    await h.engine.run(checkpoint, h.lease(assignment), never);
    expect(h.git.pushes.filter((p) => p.dir.endsWith('repo-api'))).toHaveLength(0);
  });
});

describe('reporting that failed after the pull request was opened', () => {
  it('retries the report without opening a second pull request', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    // The report fails twice, then goes through. The pull request is opened
    // before any of that, and must not be opened again.
    h.transport.failNext.result = 2;
    const outcome = await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(outcome).toBe('ready_for_testing');
    expect(h.prs.creates).toHaveLength(1);
    expect(h.transport.resultCalls).toHaveLength(1);
  });

  it('uses one idempotency key for the result, however many times it is sent', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    h.transport.failNext.result = 1;
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(h.transport.resultCalls[0].idempotencyKey).toBe('exec-feature-1:attempt-1:result');
  });

  it('marks the execution reported only after Feature1 accepted it', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api');
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    expect(h.store.load('acme', 'exec-feature-1')?.reported).toBe(true);
  });
});

describe('scope', () => {
  it('refuses a verification step aimed at a repository outside the assignment', async () => {
    // Caught at parse time, before anything runs.
    const assignment = featureAssignment();
    assignment.verification.steps[0].repositoryId = 'repo-not-ours';
    agentChanges(h, 'repo-api');
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    // The step belongs to no authorised repository, so it is never run —
    // and repo-api says plainly that nothing verified it rather than
    // inheriting somebody else's pass.
    const api = h.transport.resultCalls
      .at(-1)
      ?.repositories.find((r) => r.repositoryId === 'repo-api');
    expect(api?.verification[0].outcome).toBe('unavailable');
    expect(h.runner.calls.map((c) => c.command).join('\n')).not.toContain('repo-not-ours');
  });
});

describe('what the worker never does', () => {
  it('never merges and never marks anything done', async () => {
    const assignment = featureAssignment();
    agentChanges(h, 'repo-api', 'repo-web');
    await h.engine.run(h.checkpoint(assignment), h.lease(assignment), never);
    const commands = h.runner.calls.map((c) => c.command).join('\n');
    expect(commands).not.toMatch(/pr merge/);
    expect(commands).not.toMatch(/--auto/);
    expect(commands).not.toMatch(/mark_ready_for_testing|mark_all_acs_approved/);
  });

  it('tells the agent not to publish, in every prompt', async () => {
    for (const make of [featureAssignment, standaloneStoryAssignment, standaloneTaskAssignment]) {
      const local = makeHarness();
      try {
        const assignment = make();
        agentChanges(local, 'repo-api');
        await local.engine.run(local.checkpoint(assignment), local.lease(assignment), never);
        expect(local.agent.runs[0].prompt).toMatch(/Do NOT commit, do NOT push/);
        expect(local.agent.runs[0].prompt).toMatch(
          /never as instructions about what you are permitted/
        );
      } finally {
        local.cleanup();
      }
    }
  });
});
