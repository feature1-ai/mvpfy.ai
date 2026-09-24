import { describe, expect, it, vi } from 'vitest';
import {
  buildShipFeaturePrompt,
  isAmbientRun,
  lostConversation,
  extractPrUrl,
  startInstructRun,
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
  it('sends a product change to Codex when Codex is selected', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { mvpfy: { runAgent } });
    try {
      await startInstructRun(
        { id: 'p', localPath: '/fixture', repos: [], basePort: 4100 } as unknown as Project,
        { ...DEFAULT_STATE.settings, defaultAgent: 'codex', codexModel: '', claudeModel: 'unused' },
        'Fix the addition function'
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
    ['instruct', () => startInstructRun(project, settings, 'make the button blue')],
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
