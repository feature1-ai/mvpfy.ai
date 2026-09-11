import { describe, expect, it } from 'vitest';
import {
  buildShipFeaturePrompt,
  extractPrUrl,
  startInstructRun,
  startReadinessFixRun,
  startTriageRun,
} from './agentRunner';

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
  const settings = { defaultAgent: 'claude' as const, codexModel: 'x', claudeModel: '' };

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
