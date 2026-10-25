import { describe, expect, it, vi } from 'vitest';
import {
  buildBootstrapPrompt,
  buildShipFeaturePrompt,
  isAmbientRun,
  codexThreadId,
  lostConversation,
  extractPrUrl,
  startChatRun,
  startReadinessFixRun,
  startTriageRun,
  startGitAuthRun,
  startPlanStoryRun,
  startRaisePrRun,
  startSyncFeatureRun,
} from './agentRunner';
import type { Project, RunExitEvent } from '../../shared/types';
import { DEFAULT_STATE } from '../../shared/types';

describe('selected agent routing', () => {
  it('sends a product change to the agent chosen for that part, not the default', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { mvpfy: { runAgent } });
    try {
      await startChatRun(
        { id: 'p', localPath: '/fixture', repos: [], basePort: 4100 } as unknown as Project,
        {
          ...DEFAULT_STATE.settings,
          defaultAgent: 'claude',
          codexModel: '',
          claudeModel: 'unused',
        },
        {
          conversationId: 'c1',
          message: 'Fix the addition function',
          agent: 'codex',
          app: { id: 'web', name: 'Customer portal', kind: 'web', repo: 'web' },
        }
      );
      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'codex',
          model: '',
          repoPath: '/fixture',
          promptText: expect.stringContaining('Fix the addition function'),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PR run registration', () => {
  it('registers before IPC starts emitting output and never reinitializes afterward', async () => {
    const track = vi.fn();
    const fail = vi.fn();
    vi.stubGlobal('window', {
      mvpfy: {
        raisePullRequests: async (runId: string) => {
          expect(track).toHaveBeenCalledWith(
            expect.objectContaining({ runId, planSlug: 'feature' })
          );
        },
      },
    });
    try {
      await startRaisePrRun(
        { id: 'p', localPath: '/repo', repos: [] } as unknown as Project,
        'feature',
        'mvpfy/feature',
        'Feature',
        'Body',
        { track, fail }
      );
      expect(track).toHaveBeenCalledOnce();
      expect(fail).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records a command preparation error as a failed run', async () => {
    const track = vi.fn();
    const fail = vi.fn();
    vi.stubGlobal('window', {
      mvpfy: {
        raisePullRequests: async () => {
          throw new Error('Nothing to raise');
        },
      },
    });
    try {
      await expect(
        startRaisePrRun(
          { id: 'p', localPath: '/repo', repos: [] } as unknown as Project,
          'feature',
          'mvpfy/feature',
          'Feature',
          'Body',
          { track, fail }
        )
      ).rejects.toThrow('Nothing to raise');
      expect(fail).toHaveBeenCalledWith(track.mock.calls[0][0].runId, 'Nothing to raise');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('credential repair before PR retry', () => {
  for (const code of [0, 1, null]) {
    it(`waits for exit ${code} and only permits a retry on success`, async () => {
      let listener!: (event: RunExitEvent) => void;
      let runId = '';
      const off = vi.fn();
      const track = vi.fn();
      vi.stubGlobal('window', {
        mvpfy: {
          onRunExit: (fn: typeof listener) => {
            listener = fn;
            return off;
          },
          cliLogin: async (id: string) => {
            runId = id;
            expect(track).toHaveBeenCalled();
          },
        },
      });
      try {
        let settled = false;
        const run = startGitAuthRun({ id: 'project' } as Project, track);
        const result = run.then(
          () => {
            settled = true;
            return 'ok';
          },
          () => {
            settled = true;
            return 'failed';
          }
        );
        await Promise.resolve();
        listener({ runId: 'unrelated', code: 0 });
        await Promise.resolve();
        expect(settled).toBe(false);
        listener({ runId, code });
        expect(await result).toBe(code === 0 ? 'ok' : 'failed');
        expect(off).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

  it('cleans up its listener when starting the repair fails', async () => {
    const off = vi.fn();
    vi.stubGlobal('window', {
      mvpfy: {
        onRunExit: () => off,
        cliLogin: async () => {
          throw new Error('Could not launch');
        },
      },
    });
    try {
      await expect(startGitAuthRun({ id: 'project' } as Project, vi.fn())).rejects.toThrow(
        'Could not launch'
      );
      expect(off).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('extractPrUrl', () => {
  it('finds a GitHub PR URL', () => {
    const log = 'pushed\nhttps://github.com/org/repo/pull/42\ndone';
    expect(extractPrUrl(log)).toBe('https://github.com/org/repo/pull/42');
  });

  it('finds a GitLab MR URL', () => {
    const log = 'https://gitlab.com/org/repo/-/merge_requests/7';
    expect(extractPrUrl(log)).toBe('https://gitlab.com/org/repo/-/merge_requests/7');
  });

  it('returns the last URL when several appear', () => {
    const log = 'https://github.com/org/repo/pull/1 then https://github.com/org/repo/pull/2';
    expect(extractPrUrl(log)).toBe('https://github.com/org/repo/pull/2');
  });

  it('returns null when no PR URL is present', () => {
    expect(extractPrUrl('no urls here, not even https://github.com/org/repo')).toBeNull();
  });
});

describe('buildShipFeaturePrompt', () => {
  it('substitutes repoPath and storyId placeholders', () => {
    const prompt = buildShipFeaturePrompt('/tmp/ws/repo', 'STORY-7');
    expect(prompt).toContain('/tmp/ws/repo');
    expect(prompt).toContain('STORY-7');
    expect(prompt).not.toContain('{repoPath}');
    expect(prompt).not.toContain('{storyId}');
  });
});

describe('the workspace contract', () => {
  /** Capture what a run actually sends, rather than trusting the wiring. */
  const capture = async (start: () => Promise<unknown>) => {
    let sent = '';
    (globalThis as { window?: unknown }).window = {
      mvpfy: {
        runAgent: async (req: { promptText: string }) => {
          sent = req.promptText;
        },
      },
    };
    try {
      await start();
      return sent;
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  };

  const project = {
    id: 'p1',
    repos: [],
    localPath: '/x/shop',
    basePort: 4100,
    status: 'running' as const,
    lastStoryId: null,
    generatedFiles: [],
  };
  const settings = {
    defaultAgent: 'claude' as const,
    codexModel: 'x',
    claudeModel: '',
    defaultStack: '',
  };

  const starters: Array<[string, () => Promise<unknown>]> = [
    ['triage', () => startTriageRun(project, settings, 'starting the environment', 'boom')],
    [
      'chat',
      () =>
        startChatRun(project, settings, {
          conversationId: 'c1',
          message: 'make the button blue',
          agent: 'claude',
          app: { id: 'project', name: 'Whole project', kind: 'project' },
        }),
    ],
    [
      'readiness-fix',
      () =>
        startReadinessFixRun(project, settings, {
          id: 'demo-login',
          title: 'Demo login works',
          detail: 'anyone can sign in',
          fix: 'remove it',
          evidence: ['mvpfy.yml'],
        }),
    ],
  ];

  for (const [name, start] of starters) {
    it(`tells ${name} that the published port and mvpfy.yml must agree`, async () => {
      // A fix that moves the port without updating mvpfy.yml presents as an app
      // that started and never answered — the failure being fixed, caused by it.
      const prompt = await capture(start);
      expect(prompt).toContain('host_port');
      expect(prompt).toContain('docker-compose.mvpfy.yml actually publishes');
    });

    it(`tells ${name} that the demo login has to keep working`, async () => {
      const prompt = await capture(start);
      expect(prompt).toContain('demo_login');
      expect(prompt).toContain('re-seed');
    });

    it(`leaves no placeholder unfilled in the ${name} prompt`, async () => {
      // An unfilled {name} would reach the agent as a literal brace.
      const prompt = await capture(start);
      expect(prompt).not.toMatch(/\{[a-zA-Z]\w*\}/);
    });
  }
});

describe('startSyncFeatureRun', () => {
  it('sends the feature reference, so the run updates rather than files again', async () => {
    // The whole difference between this and a push: the feature already exists.
    // A run that did not know which one would create a second and split its
    // history in two.
    let captured = '';
    vi.stubGlobal('window', {
      mvpfy: {
        runAgent: async (req: { promptText: string }) => {
          captured = req.promptText;
        },
      },
    });
    try {
      await startSyncFeatureRun(
        { id: 'p', localPath: '/repo', repos: [] } as unknown as Project,
        { defaultAgent: 'claude', codexModel: 'x', claudeModel: '', defaultStack: '' },
        'paging',
        'FEA-142',
        'let me page through products',
        { url: 'https://acme-mcp.feature1.ai/mcp/' }
      );
      expect(captured).toContain('FEA-142');
      expect(captured).toContain('let me page through products');
      expect(captured).toMatch(/Never call create_feature/i);
      // The sync must not silently start over from an empty board.
      expect(captured).toMatch(/already in Feature1/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('continuing an interrupted story', () => {
  it('tells the run that work already exists, so it does not start over', async () => {
    // Without this the run reimplements the story on top of a checkout that
    // already holds half of it, and the two halves disagree.
    let captured = '';
    vi.stubGlobal('window', {
      mvpfy: {
        runAgent: async (req: { promptText: string }) => {
          captured = req.promptText;
        },
      },
    });
    try {
      await startPlanStoryRun(
        { id: 'p', localPath: '/repo', repos: [] } as unknown as Project,
        { ...DEFAULT_STATE.settings },
        'paging',
        'US-03',
        null,
        undefined,
        undefined,
        undefined,
        {},
        true
      );
      expect(captured).toMatch(/stopped before it finished/i);
      expect(captured).toMatch(/Do not start the story again/i);
      expect(captured).toMatch(/git status/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says nothing of the sort on a first attempt', async () => {
    let captured = '';
    vi.stubGlobal('window', {
      mvpfy: {
        runAgent: async (req: { promptText: string }) => {
          captured = req.promptText;
        },
      },
    });
    try {
      await startPlanStoryRun(
        { id: 'p', localPath: '/repo', repos: [] } as unknown as Project,
        { ...DEFAULT_STATE.settings },
        'paging',
        'US-01'
      );
      expect(captured).not.toMatch(/Do not start the story again/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('where a story lands', () => {
  const promptFor = async (flow?: 'feature' | 'trunk') => {
    let captured = '';
    vi.stubGlobal('window', {
      mvpfy: {
        runAgent: async (req: { promptText: string }) => {
          captured = req.promptText;
        },
      },
    });
    try {
      await startPlanStoryRun(
        { id: 'p', localPath: '/repo', repos: [], flow } as unknown as Project,
        { ...DEFAULT_STATE.settings },
        'paging',
        'US-01',
        null,
        undefined,
        undefined,
        undefined,
        { '/repo/api': '/trees/paging/api' }
      );
    } finally {
      vi.unstubAllGlobals();
    }
    return captured;
  };

  it('keeps a feature on its own branch and checkout by default', async () => {
    const prompt = await promptFor();
    expect(prompt).toContain('already on the branch mvpfy/paging');
    expect(prompt).toContain('/trees/paging/api');
    expect(prompt).toMatch(/Push with -u/);
    expect(prompt).not.toMatch(/\{[a-zA-Z]\w*\}/);
  });

  it('commits a trunk-based story to the trunk, with no branch or pull request', async () => {
    const prompt = await promptFor('trunk');
    expect(prompt).not.toContain('mvpfy/paging');
    expect(prompt).not.toContain('/trees/paging/api');
    expect(prompt).toMatch(/pull --rebase/);
    expect(prompt).toMatch(/Never force-push/);
    expect(prompt).toMatch(/Never create, switch or delete a branch/);
    expect(prompt).not.toMatch(/\{[a-zA-Z]\w*\}/);
  });
});

describe('runs that are not activity', () => {
  it('does not count a followed log or a live share as busy', () => {
    // Both last exactly as long as somebody wants them to. Counting either as
    // activity switches off every button in the app for as long as it is
    // useful — which is how sharing an app disabled the feature buttons.
    expect(isAmbientRun('app-logs')).toBe(true);
    expect(isAmbientRun('share')).toBe(true);
  });

  it('still counts the runs that are actually doing something', () => {
    for (const kind of ['plan-story', 'docker-up', 'raise-pr', 'bootstrap'] as const) {
      expect(isAmbientRun(kind), kind).toBe(false);
    }
  });
});

describe('lostConversation', () => {
  it('spots a resume for a conversation that was never there', () => {
    // mvpfy records a feature's conversation id when it mints it, not when the
    // conversation is proved to exist — so an opening run that failed leaves
    // an id with nothing behind it, and every later run asks to resume it.
    expect(lostConversation('No conversation found with session ID: fba777bc-3cf8-431f')).toBe(
      true
    );
  });

  it('is not every failure, only the one that fixes itself', () => {
    // Forgetting the id and going again repairs this and nothing else; doing
    // it for a real failure would hide the failure and lose the context.
    expect(lostConversation('FAIL src/app.test.ts — expected 2 received 3')).toBe(false);
    expect(lostConversation('usage limit reached')).toBe(false);
    expect(lostConversation('')).toBe(false);
    expect(lostConversation(null)).toBe(false);
  });
});

describe('codexThreadId', () => {
  it('reads the thread codex says it opened', () => {
    // Verified against codex-cli 0.155.1: this is the first line of
    // `codex exec --json`, before any model output.
    const log = '{"type":"thread.started","thread_id":"01a15f63-9840-7923-b234-467203792ce8"}\n';
    expect(codexThreadId(log)).toBe('01a15f63-9840-7923-b234-467203792ce8');
  });

  it('is not fooled by a thread id belonging to some other event', () => {
    expect(codexThreadId('{"type":"turn.started","thread_id":"nope"}')).toBeNull();
  });

  it('says nothing when there is nothing to say', () => {
    expect(codexThreadId('')).toBeNull();
    expect(codexThreadId(null)).toBeNull();
    expect(codexThreadId('claude output, no threads here')).toBeNull();
  });

  it('only looks at the head of a log that grows to megabytes', () => {
    // Runs on every chunk of a live stream, so it must not scan the whole of
    // one. The line it wants is the first thing codex prints.
    const buried = 'x'.repeat(20_000) + '{"type":"thread.started","thread_id":"late"}';
    expect(codexThreadId(buried)).toBeNull();
  });
});

describe('lostConversation', () => {
  it('recognises a conversation neither agent can find', () => {
    // Both messages observed from the CLIs themselves.
    expect(lostConversation('No conversation found with session ID: abc')).toBe(true);
    expect(
      lostConversation('Error: thread/resume failed: no rollout found for thread id 000')
    ).toBe(true);
  });

  it('does not treat an ordinary failure as a lost conversation', () => {
    // This one retries by itself, so a false positive silently runs a story
    // twice.
    expect(lostConversation('error: tests failed')).toBe(false);
    expect(lostConversation(null)).toBe(false);
  });
});

describe('the feature map in a story prompt', () => {
  async function promptFor(notesExists: boolean): Promise<string> {
    let captured = '';
    vi.stubGlobal('window', {
      mvpfy: {
        runAgent: async (req: { promptText: string }) => {
          captured = req.promptText;
        },
        readRepoFiles: async (_repo: string, paths: string[]) =>
          paths.map((relativePath) => ({ relativePath, exists: notesExists, content: '' })),
        workspaceEmpty: async () => false,
      },
    });
    try {
      await startPlanStoryRun(
        { id: 'p', localPath: '/repo', repos: [] } as unknown as Project,
        { ...DEFAULT_STATE.settings },
        'paging',
        'US-03'
      );
    } finally {
      vi.unstubAllGlobals();
    }
    return captured;
  }

  it('names the map, and lets the story correct it', async () => {
    const prompt = await promptFor(true);
    expect(prompt).toContain('mvpfy-notes.paging.md');
    // The one mvpfy file a story may write: a wrong map left in place misleads
    // every story after this one.
    expect(prompt).toMatch(/exception is mvpfy-notes\.paging\.md/);
  });

  it('leaves no placeholder behind, in either case', async () => {
    // fillTemplate leaves an unknown {placeholder} exactly as it found it, so
    // a forgotten one ships to the agent as literal braces and nothing says
    // so. Both branches, because each fills a different set.
    for (const exists of [true, false]) {
      expect(await promptFor(exists)).not.toMatch(/\{[a-zA-Z]\w*\}/);
    }
  });

  it('does not send a story to a map the feature does not have', async () => {
    const prompt = await promptFor(false);
    expect(prompt).not.toContain('mvpfy-notes.paging.md');
    expect(prompt).not.toMatch(/exception is/);
    expect(prompt).toMatch(/match its patterns/i);
    // Other features' maps are still off limits, map of its own or not.
    expect(prompt).toContain('mvpfy-notes.*');
  });
});

describe('setting up after a repository is added', () => {
  const project = (pending: string[]): Project =>
    ({
      id: 'p',
      localPath: '/w/shop',
      basePort: 4100,
      repos: [],
      generatedFiles: ['docker-compose.mvpfy.yml'],
      ...(pending.length ? { reposPendingSetup: pending } : {}),
    }) as unknown as Project;

  it('extends the stack instead of rewriting it', async () => {
    // Regenerating is right for a setup that has gone stale and wrong here:
    // it rewrites the compose file "to what you would write today", which
    // can rename a service or a volume — and a renamed volume is a database
    // nothing points at any more.
    const prompt = buildBootstrapPrompt(project(['/w/shop/payments']));
    expect(prompt).toMatch(/ALREADY SET UP/);
    expect(prompt).toMatch(/EXTEND what is here, not to regenerate/);
    expect(prompt).toMatch(/Edit docker-compose\.mvpfy\.yml in place/);
    expect(prompt).not.toMatch(/REGENERATED/);
  });

  it('names the repositories that are new', () => {
    const prompt = buildBootstrapPrompt(project(['/w/shop/payments', '/w/shop/search']));
    expect(prompt).toContain('• payments');
    expect(prompt).toContain('• search');
    expect(prompt).toMatch(/2 repositories/);
  });

  it('forbids the three changes that lose somebody’s data or their tab', () => {
    const prompt = buildBootstrapPrompt(project(['/w/shop/payments']));
    expect(prompt).toMatch(/NEVER rename an existing service or an existing volume/);
    expect(prompt).toMatch(/NEVER change a host port that is already allocated/);
    expect(prompt).toMatch(/demo credentials exactly as they are/);
  });

  it('says the images that exist are built and must not be rebuilt', () => {
    // They are on the machine already; rebuilding them is minutes of
    // nothing, and tearing them down takes the app away mid-session.
    const prompt = buildBootstrapPrompt(project(['/w/shop/payments']));
    expect(prompt).toMatch(/ARE BUILT AND PRESENT/);
    expect(prompt).toMatch(/Only the new services need building/);
  });

  it('allows the answer that nothing needed adding', () => {
    const prompt = buildBootstrapPrompt(project(['/w/shop/payments']));
    expect(prompt).toMatch(/That is a good outcome, not a failure/);
  });

  it('extends rather than regenerates, even when regenerate was asked for', () => {
    // A project with a repository waiting is asking for that repository to
    // be added, not for its stack to be rewritten underneath it.
    const prompt = buildBootstrapPrompt(project(['/w/shop/payments']), true);
    expect(prompt).toMatch(/EXTEND what is here/);
    expect(prompt).not.toMatch(/REGENERATED/);
  });

  it('still regenerates when nothing is pending', () => {
    const prompt = buildBootstrapPrompt(project([]), true);
    expect(prompt).toMatch(/REGENERATED/);
    expect(prompt).not.toMatch(/EXTEND what is here/);
  });

  it('says none of it on a first setup', () => {
    const prompt = buildBootstrapPrompt(project([]));
    expect(prompt).not.toMatch(/REGENERATED|EXTEND what is here/);
  });
});
