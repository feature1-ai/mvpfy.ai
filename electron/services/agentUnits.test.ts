import { describe, expect, it } from 'vitest';
import { AgentUnit, RunAgentUnitsRequest } from '../../shared/agentUnits';
import { AgentUnitsDeps, drive } from './agentUnits';
import { SteppedRun } from './runs';

const QUESTIONS = 'mvpfy-questions.md';
const PROGRESS = 'mvpfy-setup.json';

const unit = (id: string, file: string): AgentUnit => ({
  id,
  title: `Step ${id}`,
  promptText: `do ${id}`,
  resumeText: `continue with ${id}`,
  checks: [{ kind: 'files', paths: [file] }],
});

const UNITS = [
  unit('stack', 'compose.yml'),
  unit('manifest', 'mvpfy.yml'),
  unit('handover', 'run.md'),
];

/**
 * A workspace and an agent that exist only here.
 *
 * `agent` is what each invocation does to the workspace, in order: write
 * files, exit with a code, or both. It stands in for the whole of Claude Code.
 */
function setup(
  agent: Array<{
    writes?: Record<string, string>;
    code?: number | null;
    stop?: boolean;
    output?: string;
  }>,
  opts: {
    files?: Record<string, string>;
    resume?: boolean;
    units?: AgentUnit[];
    maxAttempts?: number;
    share?: boolean;
    agent?: 'claude' | 'codex';
  } = {}
) {
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const said: Array<{ text: string; stream: string }> = [];
  const prompts: string[] = [];
  const sessions: Array<{ id: string; resume: boolean } | undefined> = [];
  const discarded: string[] = [];
  let minted = 0;
  let stopped = false;
  let invocation = 0;

  const run: SteppedRun = {
    step: async () => {
      const turn = agent[invocation++] ?? {};
      Object.assign(files, turn.writes ?? {});
      if (turn.stop) stopped = true;
      return { code: turn.code === undefined ? 0 : turn.code, output: turn.output ?? '' };
    },
    say: (text, stream = 'info') => void said.push({ text, stream }),
    stopped: () => stopped,
    end: () => {},
  };
  const deps: AgentUnitsDeps = {
    begin: () => run,
    prepare: (u, _req, _repo, scratchId) => {
      prompts.push(u.promptText);
      sessions.push(u.session);
      return { command: `agent ${scratchId}`, scratch: [`prompt-${scratchId}.txt`] };
    },
    discard: (paths) => void discarded.push(...paths),
    newId: () => `minted-${(minted += 1)}`,
    access: () => ({
      read: (p) => files[p] ?? null,
      run: async () => ({ status: 0, stdout: '', stderr: '' }),
    }),
    read: (_repo, p) => files[p] ?? null,
    write: (_repo, p, content) => void (files[p] = content),
  };
  const req: RunAgentUnitsRequest = {
    runId: 'bootstrap-1',
    agent: opts.agent ?? 'claude',
    repoPath: '/work/shop',
    units: opts.units ?? UNITS,
    maxAttempts: opts.maxAttempts ?? 3,
    questionsFile: QUESTIONS,
    progressFile: PROGRESS,
    resume: opts.resume ?? false,
    shareConversation: opts.share ?? false,
  };
  return {
    files,
    said,
    prompts,
    sessions,
    discarded,
    go: () => drive(req, '/work/shop', run, deps),
    done: () => (JSON.parse(files[PROGRESS]) as { done: string[] }).done,
    kept: () =>
      (JSON.parse(files[PROGRESS]) as { conversation?: { agent: string; id: string } })
        .conversation,
    log: () => said.map((s) => s.text).join('\n'),
    invocations: () => invocation,
  };
}

const allThree = [
  { writes: { 'compose.yml': 'services: {}' } },
  { writes: { 'mvpfy.yml': 'host_port: 3001' } },
  { writes: { 'run.md': 'It runs.' } },
];

describe('a setup where every step holds', () => {
  it('runs each step once, in order, and exits zero', async () => {
    const s = setup(allThree);
    expect(await s.go()).toBe(0);
    expect(s.prompts).toEqual(['do stack', 'do manifest', 'do handover']);
    expect(s.done()).toEqual(['stack', 'manifest', 'handover']);
  });

  it('says where it is, and that each step was checked', async () => {
    const s = setup(allThree);
    await s.go();
    expect(s.log()).toContain('── Step 1 of 3: Step stack ──');
    expect(s.log()).toContain('── Step 3 of 3: Step handover ──');
    expect(s.log().match(/✓ .* — checked/g)).toHaveLength(3);
  });

  it('removes each invocation’s scratch, which can hold credentials', async () => {
    const s = setup(allThree);
    await s.go();
    expect(s.discarded).toEqual([
      'prompt-bootstrap-1-1.txt',
      'prompt-bootstrap-1-2.txt',
      'prompt-bootstrap-1-3.txt',
    ]);
  });
});

describe('a step whose evidence is missing', () => {
  it('goes back to the agent with what was missing, and carries on once it holds', async () => {
    const s = setup([
      { writes: { 'compose.yml': 'x' } },
      {}, // the manifest step wrote nothing
      { writes: { 'mvpfy.yml': 'host_port: 3001' } },
      { writes: { 'run.md': 'It runs.' } },
    ]);
    expect(await s.go()).toBe(0);
    expect(s.prompts).toHaveLength(4);
    expect(s.prompts[2]).toContain('attempt 2 of 3');
    expect(s.prompts[2]).toContain('mvpfy.yml');
    // The whole original brief, not only the complaint.
    expect(s.prompts[2]).toContain('do manifest');
    expect(s.log()).toContain('── Fixing step 2 of 3: Step manifest (attempt 2 of 3) ──');
  });

  it('gives up after its attempts, names the step, and exits non-zero', async () => {
    const s = setup([{ writes: { 'compose.yml': 'x' } }, {}, {}, {}]);
    expect(await s.go()).toBe(1);
    expect(s.invocations()).toBe(4);
    const last = s.said.at(-1);
    expect(last?.stream).toBe('stderr');
    expect(last?.text).toContain('Setup stopped at step 2 of 3 (Step manifest)');
    expect(last?.text).toContain('After 3 attempts');
    expect(last?.text).toContain('mvpfy.yml');
  });

  it('never starts the step after one that does not hold', async () => {
    const s = setup([{ writes: { 'compose.yml': 'x' } }, {}, {}, {}]);
    await s.go();
    expect(s.prompts.some((p) => p.includes('do handover'))).toBe(false);
    expect(s.done()).toEqual(['stack']);
  });

  it('does not repair at all when one attempt is all a step gets', async () => {
    const s = setup([{}], { maxAttempts: 1 });
    expect(await s.go()).toBe(1);
    expect(s.invocations()).toBe(1);
  });
});

describe('an agent that does not finish', () => {
  it('ends the run with the agent’s own exit code, and does not check its work', async () => {
    const s = setup([{ writes: { 'compose.yml': 'x' }, code: 137 }]);
    expect(await s.go()).toBe(137);
    expect(s.done()).toEqual([]);
    expect(s.log()).not.toContain('✓');
    expect(s.said.at(-1)?.text).toContain('exit code 137');
  });

  it('ends non-zero when the agent could not be started at all', async () => {
    const s = setup([{ code: null }]);
    expect(await s.go()).toBe(1);
  });

  it('stops to ask, exits zero as a blocked run always has, and leaves the step open', async () => {
    const s = setup([
      { writes: { 'compose.yml': 'x' } },
      { writes: { 'mvpfy.yml': 'host_port: 1', [QUESTIONS]: '1. Which backend?' } },
    ]);
    expect(await s.go()).toBe(0);
    expect(s.done()).toEqual(['stack']);
    expect(s.invocations()).toBe(2);
    expect(s.log()).toContain('Stopped at step 2 of 3 to ask you something');
  });

  it('starts nothing more once somebody stops the run', async () => {
    const s = setup([{ writes: { 'compose.yml': 'x' }, code: null, stop: true }]);
    expect(await s.go()).toBeNull();
    expect(s.invocations()).toBe(1);
    expect(s.done()).toEqual([]);
  });

  it('does not report a stop as a success, even when the step it stopped after passed', async () => {
    // The window Stop is most likely to land in: a step's process has exited
    // cleanly and the next has not started. The step's own code is 0, and
    // returning it made a stopped setup indistinguishable from a finished
    // one — useProjectActions chains on exit code 0 and would bring the stack
    // up with no manifest, no database and no demo login. The other stop
    // branches in this driver always returned null; this one did not.
    const s = setup([{ writes: { 'compose.yml': 'x' }, code: 0, stop: true }]);
    expect(await s.go()).not.toBe(0);
    expect(s.invocations()).toBe(1);
    expect(s.done()).toEqual([]);
  });
});

describe('carrying on', () => {
  const finishedTwo = { [PROGRESS]: JSON.stringify({ version: 1, done: ['stack', 'manifest'] }) };

  it('starts at the step that was not finished', async () => {
    const s = setup([{ writes: { 'run.md': 'It runs.' } }], { files: finishedTwo, resume: true });
    expect(await s.go()).toBe(0);
    expect(s.prompts).toEqual(['do handover']);
    expect(s.log()).toContain('Already finished and checked: Step stack; Step manifest');
  });

  it('does every step again when setup was asked for afresh', async () => {
    const s = setup(allThree, { files: finishedTwo, resume: false });
    expect(await s.go()).toBe(0);
    expect(s.prompts).toHaveLength(3);
  });

  it('forgets the old record before the first step, not after the last', async () => {
    const s = setup([{ code: 1 }], { files: finishedTwo, resume: false });
    await s.go();
    expect(s.done()).toEqual([]);
  });

  it('ignores a record of steps this setup does not have', async () => {
    const stale = { [PROGRESS]: JSON.stringify({ version: 1, done: ['containers', 'stack'] }) };
    const s = setup(allThree.slice(1), { files: stale, resume: true });
    await s.go();
    expect(s.done()).toEqual(['stack', 'manifest', 'handover']);
  });

  it('treats an unreadable record as nothing finished', async () => {
    const s = setup(allThree, { files: { [PROGRESS]: '{not json' }, resume: true });
    expect(await s.go()).toBe(0);
    expect(s.prompts).toHaveLength(3);
  });

  it('records a step the moment it is checked, so a crash in the next one keeps it', async () => {
    const s = setup([{ writes: { 'compose.yml': 'x' } }, { code: 1 }]);
    await s.go();
    expect(s.done()).toEqual(['stack']);
  });
});

describe('one conversation across the steps', () => {
  const share = { share: true };

  it('opens it on the first step and continues it on every one after', async () => {
    const s = setup(allThree, share);
    expect(await s.go()).toBe(0);
    expect(s.sessions).toEqual([
      { id: 'minted-1', resume: false },
      { id: 'minted-1', resume: true },
      { id: 'minted-1', resume: true },
    ]);
  });

  it('gives the whole brief once, then only what each step is', async () => {
    const s = setup(allThree, share);
    await s.go();
    expect(s.prompts).toEqual(['do stack', 'continue with manifest', 'continue with handover']);
  });

  it('fixes a failed step in the conversation that wrote it', async () => {
    const s = setup(
      [{ writes: { 'compose.yml': 'x' } }, {}, { writes: { 'mvpfy.yml': 'host_port: 1' } }, {}],
      share
    );
    await s.go();
    expect(s.sessions[2]).toEqual({ id: 'minted-1', resume: true });
    expect(s.prompts[2]).toContain('attempt 2 of 3');
    expect(s.prompts[2]).toContain('continue with manifest');
    expect(s.prompts[2]).not.toContain('do manifest');
  });

  it('leaves the conversation behind for the last try at a step that keeps failing', async () => {
    const s = setup([{ writes: { 'compose.yml': 'x' } }, {}, {}, {}], share);
    expect(await s.go()).toBe(1);
    expect(s.sessions[2]).toEqual({ id: 'minted-1', resume: true });
    // Third and last: a new conversation, so it needs the whole brief again.
    expect(s.sessions[3]).toEqual({ id: 'minted-2', resume: false });
    expect(s.prompts[3]).toContain('do manifest');
    expect(s.prompts[3]).toContain('attempt 3 of 3');
  });

  it('carries on in the fresh conversation once a last try has opened one', async () => {
    const s = setup(
      [
        { writes: { 'compose.yml': 'x' } },
        {},
        {},
        { writes: { 'mvpfy.yml': 'host_port: 1' } },
        { writes: { 'run.md': 'It runs.' } },
      ],
      share
    );
    expect(await s.go()).toBe(0);
    expect(s.sessions[4]).toEqual({ id: 'minted-2', resume: true });
  });

  it('starts a fresh one, once, when the conversation turns out not to exist', async () => {
    const s = setup(
      [
        { writes: { 'compose.yml': 'x' } },
        { code: 1, output: 'No conversation found with session ID: minted-1' },
        { writes: { 'mvpfy.yml': 'host_port: 1' } },
        { writes: { 'run.md': 'It runs.' } },
      ],
      share
    );
    expect(await s.go()).toBe(0);
    expect(s.sessions[2]).toEqual({ id: 'minted-2', resume: false });
    expect(s.prompts[2]).toBe('do manifest');
    expect(s.log()).toContain('The earlier conversation is no longer there');
    // It cost an invocation, not one of the step's attempts.
    expect(s.log()).not.toContain('Fixing');
    expect(s.sessions[3]).toEqual({ id: 'minted-2', resume: true });
  });

  it('does not mistake any other failure for a lost conversation', async () => {
    const s = setup(
      [{ writes: { 'compose.yml': 'x' } }, { code: 1, output: 'rate limited' }],
      share
    );
    expect(await s.go()).toBe(1);
    expect(s.invocations()).toBe(2);
  });

  it('gives up when the fresh conversation fails as well', async () => {
    const s = setup(
      [
        { writes: { 'compose.yml': 'x' } },
        { code: 1, output: 'No conversation found with session ID' },
        { code: 2 },
      ],
      share
    );
    expect(await s.go()).toBe(2);
    expect(s.invocations()).toBe(3);
  });

  it('reads the id codex chose out of its first step, and continues that', async () => {
    const thread = '{"type":"thread.started","thread_id":"thr_9"}\n';
    const s = setup([{ ...allThree[0], output: thread }, allThree[1], allThree[2]], {
      share: true,
      agent: 'codex',
    });
    expect(await s.go()).toBe(0);
    expect(s.sessions).toEqual([
      undefined,
      { id: 'thr_9', resume: true },
      { id: 'thr_9', resume: true },
    ]);
    expect(s.kept()).toEqual({ agent: 'codex', id: 'thr_9' });
  });

  it('gives codex the whole brief each time when it never said which thread it opened', async () => {
    const s = setup(allThree, { share: true, agent: 'codex' });
    expect(await s.go()).toBe(0);
    expect(s.sessions).toEqual([undefined, undefined, undefined]);
    expect(s.prompts).toEqual(['do stack', 'do manifest', 'do handover']);
    expect(s.kept()).toBeUndefined();
  });

  it('remembers the conversation, so a run that carries on later carries on in it', async () => {
    const first = setup([{ writes: { 'compose.yml': 'x' } }, { code: 1 }], share);
    await first.go();
    expect(first.kept()).toEqual({ agent: 'claude', id: 'minted-1' });

    const second = setup([{ writes: { 'mvpfy.yml': 'host_port: 1' } }, allThree[2]], {
      share: true,
      resume: true,
      files: { [PROGRESS]: first.files[PROGRESS], 'compose.yml': 'x' },
    });
    expect(await second.go()).toBe(0);
    expect(second.sessions[0]).toEqual({ id: 'minted-1', resume: true });
    expect(second.prompts[0]).toBe('continue with manifest');
  });

  it('does not continue a conversation the other agent opened', async () => {
    const record = JSON.stringify({
      version: 1,
      done: ['stack'],
      conversation: { agent: 'codex', id: 'thr_9' },
    });
    const s = setup([allThree[1], allThree[2]], {
      share: true,
      resume: true,
      files: { [PROGRESS]: record, 'compose.yml': 'x' },
    });
    await s.go();
    expect(s.sessions[0]).toEqual({ id: 'minted-1', resume: false });
    expect(s.prompts[0]).toBe('do manifest');
  });

  it('forgets the conversation when setup is asked for afresh', async () => {
    const record = JSON.stringify({
      version: 1,
      done: [],
      conversation: { agent: 'claude', id: 'old' },
    });
    const s = setup(allThree, { share: true, files: { [PROGRESS]: record } });
    await s.go();
    expect(s.sessions[0]).toEqual({ id: 'minted-1', resume: false });
  });

  it('uses no conversation at all when not asked to share one', async () => {
    const s = setup(allThree);
    await s.go();
    expect(s.sessions).toEqual([undefined, undefined, undefined]);
    expect(s.prompts).toEqual(['do stack', 'do manifest', 'do handover']);
  });
});
