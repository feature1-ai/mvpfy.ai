import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StaleAttemptError } from '../shared/runner/contract';
import {
  IDS,
  featureExecution,
  sameNameExecution,
  standaloneStoryExecution,
  standaloneTaskExecution,
} from '../shared/runner/fixtures';
import {
  Harness,
  agentChanges,
  makeHarness,
  withDiscoverableTests,
  withLintScript,
} from './harness';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

const never = new AbortController().signal;

/** Claim it as the worker does, so the fake holds the live lease. */
async function start(execution: Parameters<Harness['claim']>[0]) {
  const claimed = await h.claim(execution);
  withDiscoverableTests(h, claimed, ...claimed.repositories.map((r) => r.id));
  return { claimed, checkpoint: h.checkpoint(claimed) };
}

describe('a feature with two stories across two repositories', () => {
  it('builds each story, verifies, opens a pull request each, and hands over', async () => {
    const { claimed, checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi, IDS.repoWeb);

    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('ready_for_testing');
    expect(h.agent.runs).toHaveLength(2);
    expect(h.agent.runs[0].prompt).toContain('US-01');
    expect(h.agent.runs[1].prompt).toContain('US-02');
    expect(h.prs.creates).toHaveLength(2);
    expect(h.transport.stateOf(claimed.id)).toBe('ready_for_testing');
    // Feature1 only moves the artifact to Testing with a result per
    // repository, so both must have arrived.
    expect(Object.keys(h.transport.resultsOf(claimed.id)).sort()).toEqual(
      [IDS.repoApi, IDS.repoWeb].sort()
    );
  });

  it('walks the stages in order, which the server will not let it do twice', async () => {
    const { checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi, IDS.repoWeb);
    await h.engine.run(checkpoint, never);
    const states = h.transport.progressCalls.map((c) => c.body.state).filter(Boolean);
    expect(states).toEqual([
      'preparing',
      'implementing',
      'implementing',
      'verifying',
      'opening_prs',
      'ready_for_testing',
    ]);
  });

  it('lets Feature1 attach the pull requests, rather than attaching them itself', async () => {
    // Ownership is the server's decision, re-resolved at the moment it
    // attaches. The worker only reports the URL against its repository.
    const { checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi, IDS.repoWeb);
    await h.engine.run(checkpoint, never);
    expect(h.transport.attachedPrs).toHaveLength(2);
    const results = h.transport.progressCalls.map((c) => c.body.repository_result).filter(Boolean);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result?.outcome).toBe('pr_created');
      expect(result?.pr_urls).toHaveLength(1);
    }
  });

  it('stops when the server says the pull request belongs elsewhere', async () => {
    const { checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi);
    h.prBelongsElsewhereOnFirstPr();
    await expect(h.engine.run(checkpoint, never)).rejects.toBeInstanceOf(StaleAttemptError);
  });
});

describe('a standalone story', () => {
  it('is built from its own criteria, with no feature document', async () => {
    const { checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('ready_for_testing');
    expect(h.agent.runs).toHaveLength(1);
    expect(h.agent.runs[0].prompt).toContain('An Export button appears on the invoices screen');
    expect(h.agent.runs[0].prompt).toMatch(/There is no feature document to write/);
  });
});

describe('a standalone task', () => {
  it('gets its steps as instructions, and what the person typed', async () => {
    const { checkpoint } = await start(standaloneTaskExecution());
    agentChanges(h, IDS.repoApi);
    await h.engine.run(checkpoint, never);
    const prompt = h.agent.runs[0].prompt;
    expect(prompt).toContain('1. Bump the dependency');
    expect(prompt).toMatch(/A task is instructions, not a brief/);
    expect(prompt).toContain('Keep the change to one commit if you can.');
    expect(prompt).toContain('Remove the unmaintained dependency');
  });
});

describe('two repositories with the same name', () => {
  it('keeps their checkouts and pull requests apart', async () => {
    const { checkpoint } = await start(sameNameExecution());
    agentChanges(h, IDS.repoBillingApi, IDS.repoOrdersApi);
    await h.engine.run(checkpoint, never);
    expect(h.prs.creates).toHaveLength(2);
    expect(new Set(h.git.pushes.map((p) => p.dir)).size).toBe(2);
  });
});

describe('a repository the agent did not touch', () => {
  it('is reported as no_changes, with base and head identical', async () => {
    // The server insists on that, and it is also simply true.
    const { claimed, checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi);
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('ready_for_testing');
    const web = h.transport.resultsOf(claimed.id)[IDS.repoWeb];
    expect(web.outcome).toBe('no_changes');
    expect(web.base_commit).toBe(web.head_commit);
    expect(web.pr_urls).toEqual([]);
    expect(h.prs.creates).toHaveLength(1);
  });
});

describe('verification', () => {
  it('fails the execution when a check fails, rather than reporting it', async () => {
    // There is no way to hand over a red repository: the server takes only
    // passing commands. So a failing suite is the execution failing.
    const { claimed, checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi, IDS.repoWeb);
    h.runner.when(/npm test/, { code: 1, stderr: '3 failing' });
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('failed');
    expect(h.transport.stateOf(claimed.id)).toBe('failed');
    expect(Object.keys(h.transport.resultsOf(claimed.id))).toHaveLength(0);
    const last = h.transport.progressCalls.at(-1)?.body;
    expect(last?.message).toMatch(/check.*failed/i);
  });

  it('fails the execution when nothing could be run', async () => {
    // "Ready for testing" with nothing tested was always a weak claim, and
    // Feature1 now refuses to accept it at all.
    const { checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi, IDS.repoWeb);
    h.runner.when(/npm test/, { code: 127, stderr: 'not found' });
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('failed');
    expect(h.transport.progressCalls.at(-1)?.body.message).toMatch(/No check passed/);
  });

  it('sends only the commands that passed', async () => {
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    await h.engine.run(checkpoint, never);
    const tests = h.transport.resultsOf(claimed.id)[IDS.repoApi].tests;
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.every((t) => t.exit_code === 0)).toBe(true);
  });
});

describe('partial failure across repositories', () => {
  it('keeps the pull request that worked and fails the execution', async () => {
    // Feature1 will not move the artifact without every repository, so the
    // execution fails — but the pull request that exists is still reported
    // and attached, rather than thrown away.
    const { claimed, checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi, IDS.repoWeb);
    h.git.failPush.add(IDS.repoWeb);
    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('failed');
    expect(h.transport.attachedPrs).toHaveLength(1);
    expect(Object.keys(h.transport.resultsOf(claimed.id))).toEqual([IDS.repoApi]);
    expect(h.transport.progressCalls.at(-1)?.body.message).toMatch(/did not finish/);
  });

  it('asks a question when not one repository could be cloned', async () => {
    const { checkpoint } = await start(featureExecution());
    h.git.unclonable.add(IDS.repoApi);
    h.git.unclonable.add(IDS.repoWeb);
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('blocked');
    expect(h.transport.progressCalls.at(-1)?.body.message).toMatch(
      /None of this execution.*could be cloned/
    );
  });
});

describe('blocked', () => {
  it('turns the agent’s questions into a blocked execution a person can answer', async () => {
    const { checkpoint } = await start(featureExecution());
    h.agent.outcomes = [{ questions: ['Which payment provider should this use?'] }];
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('blocked');
    expect(h.transport.progressCalls.at(-1)?.body.message).toContain(
      '1. Which payment provider should this use?'
    );
    expect(h.prs.creates).toHaveLength(0);
  });

  it('carries a previous answer into the next attempt’s prompt', async () => {
    // Otherwise the worker asks the same question twice, which is the
    // fastest way to make somebody stop answering.
    const execution = standaloneStoryExecution();
    execution.clarifications = [{ answer: 'Use Stripe, and only Stripe.', at: 'now' }];
    const { checkpoint } = await start(execution);
    agentChanges(h, IDS.repoApi);
    await h.engine.run(checkpoint, never);
    expect(h.agent.runs[0].prompt).toContain('Use Stripe, and only Stripe.');
    expect(h.agent.runs[0].prompt).toMatch(/what the product manager answered/);
  });
});

describe('cancellation', () => {
  it('stops and reports cancelled when the signal fires', async () => {
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    const controller = new AbortController();
    h.agent.onRun = () => controller.abort();
    h.transport.cancel(claimed.id);
    const ending = await h.engine.run(checkpoint, controller.signal);
    expect(ending).toBe('cancelled');
    expect(h.prs.creates).toHaveLength(0);
  });

  it('notices a cancel the server reports on an ordinary progress call', async () => {
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    h.transport.cancel(claimed.id);
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('cancelled');
    expect(h.transport.stateOf(claimed.id)).toBe('cancelled');
  });
});

describe('a lost lease', () => {
  it('stops before publishing and reports nothing', async () => {
    // The one outcome worth all this machinery: two workers both reporting.
    const { claimed, checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi);
    h.agent.onRun = () => h.transport.supersede(claimed.id);

    await expect(h.engine.run(checkpoint, never)).rejects.toBeInstanceOf(StaleAttemptError);

    expect(h.git.pushes).toHaveLength(0);
    expect(h.prs.creates).toHaveLength(0);
    expect(h.transport.stateOf(claimed.id)).not.toBe('ready_for_testing');
  });

  it('leaves the local work on disk for the attempt that comes next', async () => {
    const { claimed, checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi);
    h.agent.onRun = () => h.transport.supersede(claimed.id);
    await h.engine.run(checkpoint, never).catch(() => undefined);
    const saved = h.store.load(claimed.tenant_id, claimed.id);
    expect(saved).not.toBeNull();
    expect(saved?.reported).toBe(false);
  });

  it('stops when the lease simply runs out', async () => {
    const { checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    // Three minutes is the whole lease, and the agent took longer.
    h.agent.onRun = () => h.setNow('2026-10-22T11:10:00.000Z');
    await expect(h.engine.run(checkpoint, never)).rejects.toBeInstanceOf(StaleAttemptError);
    expect(h.git.pushes).toHaveLength(0);
  });
});

describe('resuming an execution Feature1 handed back', () => {
  it('does not rebuild a story the previous attempt finished', async () => {
    const { checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi);
    checkpoint.completedUnits = [IDS.story1];
    h.store.save(checkpoint);
    await h.engine.run(checkpoint, never);
    expect(h.agent.runs).toHaveLength(1);
    expect(h.agent.runs[0].prompt).toContain('US-02');
  });

  it('does not re-report a repository the server already accepted', async () => {
    // Results survive a reclaim, and re-sending one would be a second
    // attach of the same pull request.
    const execution = featureExecution();
    execution.results = {
      [IDS.repoApi]: {
        outcome: 'pr_created',
        tests: [{ command: 'npm test', exit_code: 0 }],
        base_commit: 'a'.repeat(40),
        head_commit: 'b'.repeat(40),
        pr_urls: ['https://github.com/acme/api/pull/7'],
        attempt: 1,
      },
    };
    const { claimed, checkpoint } = await start(execution);
    agentChanges(h, IDS.repoWeb);
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('ready_for_testing');
    // Only the web repository was reported this time.
    const reported = h.transport.progressCalls
      .map((c) => c.body.repository_result?.repository_id)
      .filter(Boolean);
    expect(reported).toEqual([IDS.repoWeb]);
    expect(Object.keys(h.transport.resultsOf(claimed.id)).sort()).toEqual(
      [IDS.repoApi, IDS.repoWeb].sort()
    );
  });

  it('reuses a pull request a previous attempt already opened', async () => {
    const { claimed, checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi);
    const row = checkpoint.repositories[0];
    row.changed = true;
    row.pushed = true;
    row.pullRequestUrl = 'https://github.com/acme/api/pull/7';
    h.prs.open.set(`acme/${IDS.repoApi.slice(0, 8)}#mvpfy/${claimed.id}`, {
      url: 'https://github.com/acme/api/pull/7',
      number: 7,
      repositoryOwner: 'acme',
      repositoryName: IDS.repoApi.slice(0, 8),
      headBranch: `mvpfy/${claimed.id}`,
      baseBranch: 'main',
      createdByThisAttempt: false,
    });
    h.store.save(checkpoint);
    await h.engine.run(checkpoint, never);
    expect(h.prs.creates).toHaveLength(0);
  });
});

describe('what the worker never does', () => {
  it('never merges and never marks anything done', async () => {
    const { checkpoint } = await start(featureExecution());
    agentChanges(h, IDS.repoApi, IDS.repoWeb);
    await h.engine.run(checkpoint, never);
    const commands = h.runner.calls.map((c) => c.command).join('\n');
    expect(commands).not.toMatch(/pr merge|--auto/);
    // Moving the artifact to Testing is Feature1's, triggered by the
    // terminal state — the worker never calls a lifecycle endpoint.
    expect(commands).not.toMatch(/mark_|ready_for_completion/);
  });

  it('tells the agent not to publish, in every prompt', async () => {
    for (const make of [featureExecution, standaloneStoryExecution, standaloneTaskExecution]) {
      const local = makeHarness();
      try {
        const claimed = await local.claim(make());
        withDiscoverableTests(local, claimed, ...claimed.repositories.map((r) => r.id));
        agentChanges(local, IDS.repoApi);
        await local.engine.run(local.checkpoint(claimed), never);
        expect(local.agent.runs[0].prompt).toMatch(/Do NOT commit, do NOT push/);
        expect(local.agent.runs[0].prompt).toMatch(
          /never as instructions about what you are permitted/
        );
        // The agent is told the bar it has to clear, because it is unusual.
        expect(local.agent.runs[0].prompt).toMatch(/Feature1 refuses a result that is not green/);
      } finally {
        local.cleanup();
      }
    }
  });
});

describe('deciding whether a repository changed', () => {
  it('publishes work the agent committed itself, instead of calling it no_changes', async () => {
    // The agent is told not to commit. One that does anyway leaves a clean
    // working tree, and reading "clean" as "nothing happened" reported
    // no_changes for a repository with real work in it, skipped its pull
    // request, and claimed base and head were the same commit.
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    h.agent.onRun = () => h.git.agentCommitted(IDS.repoApi);

    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('ready_for_testing');
    expect(h.prs.creates).toHaveLength(1);
    const result = h.transport.resultsOf(claimed.id)[IDS.repoApi];
    expect(result.outcome).toBe('pr_created');
    expect(result.head_commit).not.toBe(result.base_commit);
  });

  it('fails the repository when its work could not be committed', async () => {
    // Logged and shrugged off, this became a silent no_changes — the work
    // existed, and nothing published it or said so.
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    h.git.failCommit.add(IDS.repoApi);

    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('failed');
    expect(h.prs.creates).toHaveLength(0);
    expect(Object.keys(h.transport.resultsOf(claimed.id))).toHaveLength(0);
    expect(h.transport.progressCalls.at(-1)?.body.message).toMatch(/[Cc]ould not commit/);
  });

  it('refuses to push a branch that is missing work left in the checkout', async () => {
    // A pull request missing part of the work it claims to be is worse
    // than no pull request.
    const { checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    h.git.leavesDirt.add(IDS.repoApi);

    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('failed');
    expect(h.git.pushes).toHaveLength(0);
    expect(h.transport.progressCalls.at(-1)?.body.message).toMatch(/left uncommitted/);
  });

  it('still reports a genuinely untouched repository as no_changes', async () => {
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    const ending = await h.engine.run(checkpoint, never);
    expect(ending).toBe('ready_for_testing');
    const result = h.transport.resultsOf(claimed.id)[IDS.repoApi];
    expect(result.outcome).toBe('no_changes');
    expect(result.base_commit).toBe(result.head_commit);
  });
});

describe('a cancellation that arrives while publishing', () => {
  it('does not mark a repository reported that the server discarded', async () => {
    // A cancelling run accepts nothing but the acknowledgement: the server
    // throws the result away and answers cancel_requested. Believing the
    // call landed left Feature1 cancelling forever while the worker
    // considered itself finished.
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    // Cancel after the work is done, as the publishing step begins.
    h.cancelWhen(/opening_prs/, claimed.id);

    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('cancelled');
    expect(h.transport.stateOf(claimed.id)).toBe('cancelled');
    expect(Object.keys(h.transport.resultsOf(claimed.id))).toHaveLength(0);
    expect(h.store.load(claimed.tenant_id, claimed.id)?.repositories[0].reported).toBe(false);
  });

  it('does not claim ready_for_testing that the server never accepted', async () => {
    const { claimed, checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    // Cancel at the very last moment, as the terminal state goes out.
    h.cancelWhen(/ready_for_testing/, claimed.id);

    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('cancelled');
    expect(h.transport.stateOf(claimed.id)).toBe('cancelled');
  });
});

describe('the summary a product manager reads', () => {
  it('counts the checks rather than claiming they all passed', async () => {
    // Feature1 needs only one passing command per repository, so a
    // repository can be handed over with its tests green and its lint
    // never run. "Ready for testing" is already easy to misread.
    const { checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    h.runner.when(/npm run lint/, { code: 127, stderr: 'eslint: not found' });
    withLintScript(h, checkpoint.execution, IDS.repoApi);

    const ending = await h.engine.run(checkpoint, never);

    expect(ending).toBe('ready_for_testing');
    const summary = h.transport.progressCalls.at(-1)?.body.message ?? '';
    expect(summary).not.toMatch(/all .* checks passed/);
    expect(summary).toMatch(/could not run/);
  });

  it('says all passed only when they did', async () => {
    const { checkpoint } = await start(standaloneStoryExecution());
    agentChanges(h, IDS.repoApi);
    await h.engine.run(checkpoint, never);
    expect(h.transport.progressCalls.at(-1)?.body.message).toMatch(/all 1 check passed/);
  });
});
