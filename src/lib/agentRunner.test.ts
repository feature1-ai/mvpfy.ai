import { describe, expect, it, vi } from 'vitest';
import {
  buildShipFeaturePrompt,
  extractPrUrl,
  startInstructRun,
  startReadinessFixRun,
  startTriageRun,
  startGitAuthRun,
  startRaisePrRun,
  startSyncFeatureRun,
} from './agentRunner';
import type { Project, RunExitEvent } from '../../shared/types';

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
