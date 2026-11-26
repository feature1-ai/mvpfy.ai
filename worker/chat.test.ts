import { describe, expect, it } from 'vitest';
import { ChatDeps, ChatRepository, ChatSession, chatTurn, chatUndo } from './chat';
import { commandFrom } from './config';

const repo: ChatRepository = {
  id: 'r1',
  name: 'thankyoudoctor',
  dir: '/w/previews/pabcdefghijkl/r1',
  branch: 'mvpfy/x',
  base: 'main',
};
const claudeSays = (text: string) =>
  JSON.stringify({ type: 'result', is_error: false, result: text });

/** A world where the agent's replies, the files it leaves and the checks are scripted. */
function world(script: {
  replies: string[];
  edits: boolean[];
  checks?: Array<'passed' | 'failed' | 'unavailable'>;
  session?: ChatSession | null;
}) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const sessions: Array<{ id: string; resume: boolean } | undefined> = [];
  let kept = script.session ?? null;
  let dirty = false;
  let turn = 0;
  let checkRun = 0;
  const deps: ChatDeps = {
    agent: {
      run: async (input) => {
        prompts.push(input.prompt);
        sessions.push(input.session);
        dirty = script.edits[turn] ?? false;
        const reply = script.replies[turn++] ?? '';
        return {
          code: 0,
          cancelled: false,
          timedOut: false,
          questions: [],
          tail: '',
          output: claudeSays(reply),
        };
      },
    },
    agentKind: 'claude',
    git: {
      exclude: async (_dir, pattern) => void calls.push(`exclude ${pattern}`),
      uncommitted: async () => ({ paths: dirty ? ['layouts/admin.vue'] : [], withheld: [] }),
      commit: async (_dir, message, paths) => {
        if (!paths.length) return null;
        dirty = false;
        calls.push(`commit ${message}`);
        return `sha${calls.length}`.padEnd(12, '0');
      },
      pushHead: async (_dir, branch) => void calls.push(`push ${branch}`),
      originUrl: async () => 'https://github.com/feature1-ai/thankyoudoctor.git',
      revert: async (_dir, sha) => (calls.push(`revert ${sha}`), 'revertsha00000'),
      hasCommit: async (_dir, sha) => sha.startsWith('sha'),
      headCommit: async () => 'sha3000000000',
      resetTo: async (_dir, ref) => void calls.push(`reset ${ref}`),
    },
    verifier: {
      verifyRepository: async () => {
        const outcome = script.checks?.[checkRun++] ?? 'passed';
        return [
          {
            stepId: 't',
            kind: 'test',
            name: 'npm test',
            command: 'npm test',
            repositoryId: 'r1',
            outcome,
            exitCode: outcome === 'passed' ? 0 : 1,
            durationMs: 1,
            summary: '',
            ...(outcome === 'failed' ? { output: 'expected Safety, got Safety & pilot' } : {}),
          },
        ];
      },
    },
    pullRequests: {
      findExisting: async () =>
        ({ url: 'https://github.com/feature1-ai/thankyoudoctor/pull/6', number: 6 }) as never,
      comment: async (_t, n, body) => (
        calls.push(`pr comment #${n}: ${body.split('\n')[0]}`),
        true
      ),
    },
    note: async (body) => (calls.push(`feature1 note: ${body.split('\n')[0]}`), true),
    restart: async () => void calls.push('restart'),
    template: '{resumeNote}|{workTitle}|{message}',
    session: { load: () => kept, save: (s) => void (kept = s) },
    agentDir: '/w/conversations/a',
    questionsFile: '/w/conversations/q.md',
    newId: () => 'session-1',
    log: () => {},
  };
  return { deps, calls, prompts, sessions, kept: () => kept };
}

const request = {
  message: 'Rename the menu item to Safety',
  code: 'THA-F-11',
  title: 'Publish',
  by: 'Abdul',
};

describe('a conversation beside a test link', () => {
  it('makes a change straight away, checks it, adds it to the pull request and tells Feature1', async () => {
    const w = world({
      replies: ['The menu says Safety now.\nChanged: yes\nRestart: no'],
      edits: [true],
    });
    const outcome = await chatTurn(repo.dir, [repo], request, w.deps);
    expect(outcome).toMatchObject({
      reply: 'The menu says Safety now.',
      changed: true,
      pushed: true,
      notPushed: null,
      pullRequest: 'https://github.com/feature1-ai/thankyoudoctor/pull/6',
      noted: true,
      restarted: false,
    });
    expect(w.calls).toEqual([
      'exclude /.mvpfy/',
      'commit Change from the test link: Rename the menu item to Safety',
      'push mvpfy/x',
      'pr comment #6: **Changed from the test link** by Abdul:',
      'feature1 note: **Changed from the test link** by Abdul:',
    ]);
    expect(w.prompts[0]).toContain('THA-F-11 — Publish');
    expect(w.sessions[0]).toEqual({ id: 'session-1', resume: false });
    expect(w.kept()).toEqual({ agent: 'claude', id: 'session-1' });
  });

  it('only answers a question, and continues the same conversation next time', async () => {
    const w = world({
      replies: ['It stops new drafts and hides published stories.\nChanged: no\nRestart: no'],
      edits: [false],
      session: { agent: 'claude', id: 'session-0' },
    });
    const outcome = await chatTurn(repo.dir, [repo], request, w.deps);
    expect(outcome).toMatchObject({ changed: false, pushed: false, commits: [] });
    expect(w.calls).toEqual(['exclude /.mvpfy/']);
    expect(w.sessions[0]).toEqual({ id: 'session-0', resume: true });
    expect(w.prompts[0]).toMatch(/^NOTE — this continues/);
  });

  it('gives failing checks one repair, and keeps a change that still fails out of the pull request', async () => {
    const fixed = world({
      replies: ['Done.\nChanged: yes\nRestart: no', 'Fixed the test.\nChanged: yes\nRestart: no'],
      edits: [true, true],
      checks: ['failed', 'passed'],
    });
    const ok = await chatTurn(repo.dir, [repo], request, fixed.deps);
    expect(ok.pushed).toBe(true);
    expect(ok.commits).toHaveLength(2);
    expect(fixed.prompts[1]).toContain('expected Safety, got Safety & pilot');

    const stuck = world({
      replies: ['Done.\nChanged: yes\nRestart: no', 'Tried.\nChanged: no\nRestart: no'],
      edits: [true, false],
      checks: ['failed', 'failed'],
    });
    const kept = await chatTurn(repo.dir, [repo], request, stuck.deps);
    expect(kept).toMatchObject({ changed: true, pushed: false, noted: false });
    expect(kept.notPushed).toMatch(/still fail/);
    expect(stuck.calls.some((c) => c.startsWith('push'))).toBe(false);
  });

  it('does not ask for a repair when the checks could not run at all', async () => {
    const w = world({
      replies: ['Done.\nChanged: yes\nRestart: no'],
      edits: [true],
      checks: ['unavailable'],
    });
    const outcome = await chatTurn(repo.dir, [repo], request, w.deps);
    expect(w.prompts).toHaveLength(1);
    expect(outcome.pushed).toBe(false);
    expect(outcome.notPushed).toMatch(/could not run/);
  });

  it('drops a change that was never pushed, rather than reverting it', async () => {
    const w = world({ replies: [], edits: [] });
    const result = await chatUndo([repo], ['sha2000000000', 'sha3000000000'], w.deps, {
      pushed: false,
    });
    expect(result.pushed).toBe(false);
    expect(w.calls).toEqual(['reset sha2000000000^']);
  });

  it('restarts the link when the change needs it', async () => {
    const w = world({ replies: ['Added the package.\nChanged: yes\nRestart: yes'], edits: [true] });
    const outcome = await chatTurn(repo.dir, [repo], request, w.deps);
    expect(outcome.restarted).toBe(true);
    expect(w.calls).toContain('restart');
  });

  it('does not push a change to a repository the build did not touch', async () => {
    const w = world({ replies: ['Done.\nChanged: yes\nRestart: no'], edits: [true] });
    const outcome = await chatTurn(repo.dir, [{ ...repo, branch: null }], request, w.deps);
    expect(outcome.pushed).toBe(false);
    expect(outcome.notPushed).toMatch(/does not include/);
  });

  it('undoes a change, in the link and in the pull request', async () => {
    const w = world({ replies: [], edits: [] });
    expect(await chatUndo([repo], ['sha2000000000', 'sha3000000000'], w.deps)).toEqual({
      reverted: 'revertsha00000',
      pushed: true,
      error: null,
    });
    expect(w.calls).toEqual(['revert sha3000000000', 'revert sha2000000000', 'push mvpfy/x']);
    expect((await chatUndo([repo], ['abc1234'], w.deps)).error).toMatch(/no commit/);
  });

  it('takes its commands', () => {
    expect(commandFrom(['node', 'w', 'chat', 'pabcdefghijkl', 'cabcdefghijkl'])).toEqual({
      name: 'chat',
      preview: 'pabcdefghijkl',
      conversation: 'cabcdefghijkl',
    });
    expect(
      commandFrom(['node', 'w', 'chat-undo', 'pabcdefghijkl', 'cabcdefghijkl', 'abc1234'])
    ).toMatchObject({
      name: 'chat-undo',
      commit: 'abc1234',
    });
  });
});
