import { describe, expect, it } from 'vitest';
import {
  canMove,
  featureLane,
  itemId,
  parsePlan,
  serializePlan,
  slugForFeature,
  snapEstimate,
  StoryLane,
  uncoveredItems,
} from './plan';

const rawPlan = JSON.stringify({
  generatedAt: '2026-08-23',
  spec: {
    feature: 'Invoice PDF export',
    overview: {
      problem: 'Users cannot share invoices',
      summary: 'Add PDF export',
      targetUsers: 'Billing admins',
      successMetrics: ['50% of invoices exported'],
    },
    scope: {
      inScope: ['Export a single invoice as PDF', { id: 'in-custom01', text: 'Email the PDF' }],
      outOfScope: ['Bulk export'],
    },
    flows: ['Admin opens invoice and clicks Download PDF'],
    requirements: {
      functional: ['PDF matches the on-screen invoice'],
      nonFunctional: ['Export completes in under 3 seconds'],
    },
  },
  stories: [
    {
      title: 'Download invoice as PDF',
      outcome: 'An admin can save any invoice as a PDF',
      acceptanceCriteria: ['Button on invoice page', 'PDF matches screen'],
      estimate: { points: 4 },
      addresses: ['in-custom01'],
      lane: 'coding',
      order: 1,
    },
    { title: 'Second story', points: 13, order: 0 },
  ],
});

describe('parsePlan', () => {
  const plan = parsePlan(rawPlan)!;

  it('normalizes string items into stable-id objects', () => {
    expect(plan.spec.scope.inScope[0].id).toBe(itemId('in', 'Export a single invoice as PDF'));
    expect(plan.spec.scope.inScope[1].id).toBe('in-custom01');
  });

  it('mints story codes, snaps estimates, defaults lanes, sorts by order', () => {
    expect(plan.stories[0].code).toBe('US-02');
    expect(plan.stories[0].lane).toBe('todo');
    expect(plan.stories[0].estimate).toEqual({ points: 13, size: 'XL' });
    expect(plan.stories[1].estimate).toEqual({ points: 5, size: 'M' });
    expect(plan.stories[1].lane).toBe('coding');
  });

  it('returns null for garbage', () => {
    expect(parsePlan('not json')).toBeNull();
    expect(parsePlan('{}')).toBeNull();
    expect(parsePlan(null)).toBeNull();
  });

  it('preserves feature1StoryId for stories pulled from Feature1', () => {
    const pulled = parsePlan(
      JSON.stringify({
        spec: { feature: 'Pulled' },
        stories: [
          { code: 'FEA-1', title: 'From Feature1', feature1StoryId: 'sess-abc' },
          { code: 'US-2', title: 'Local' },
        ],
      })
    )!;
    expect(pulled.stories[0].feature1StoryId).toBe('sess-abc');
    expect(pulled.stories[1].feature1StoryId).toBeUndefined();
  });
});

describe('snapEstimate', () => {
  it('snaps to the Fibonacci scale with matching sizes', () => {
    expect(snapEstimate(1)).toEqual({ points: 1, size: 'XS' });
    expect(snapEstimate(4)).toEqual({ points: 5, size: 'M' });
    expect(snapEstimate(100)).toEqual({ points: 13, size: 'XL' });
    expect(snapEstimate(undefined)).toEqual({ points: 5, size: 'M' });
  });
});

describe('canMove', () => {
  it('lets the agent only advance todo→coding→testing', () => {
    expect(canMove('todo', 'coding', 'agent')).toBe(true);
    expect(canMove('coding', 'testing', 'agent')).toBe(true);
    expect(canMove('testing', 'done', 'agent')).toBe(false);
    expect(canMove('todo', 'done', 'agent')).toBe(false);
  });

  it('lets the user move anything (except no-ops)', () => {
    expect(canMove('testing', 'done', 'user')).toBe(true);
    expect(canMove('testing', 'coding', 'user')).toBe(true);
    expect(canMove('done', 'todo', 'user')).toBe(true);
    expect(canMove('todo', 'todo', 'user')).toBe(false);
  });
});

describe('uncoveredItems', () => {
  it('reports tracked spec items no story addresses', () => {
    const plan = parsePlan(rawPlan)!;
    const uncovered = uncoveredItems(plan).map((i) => i.text);
    expect(uncovered).toContain('Export a single invoice as PDF');
    expect(uncovered).not.toContain('Email the PDF');
    // out-of-scope items are not tracked for coverage
    expect(uncovered).not.toContain('Bulk export');
  });
});

describe('slugForFeature', () => {
  it('mints a short kebab slug from the description', () => {
    expect(slugForFeature('Multi-channel invoice reminders via WhatsApp!', [])).toBe(
      'multi-channel-invoice-reminders-via'
    );
  });

  it('never collides with existing slugs (legacy empty slug included)', () => {
    expect(slugForFeature('PDF export', ['', 'pdf-export'])).toBe('pdf-export-2');
    expect(slugForFeature('PDF export', ['', 'pdf-export', 'pdf-export-2'])).toBe('pdf-export-3');
  });

  it('falls back to "feature" when the description has no usable words', () => {
    expect(slugForFeature('!!!', [])).toBe('feature');
  });
});

describe('feature-level shipping', () => {
  const withFeature = (extra: Record<string, unknown>) =>
    parsePlan(
      JSON.stringify({
        version: 1,
        spec: { feature: 'Invoice export', overview: {}, scope: {}, requirements: {} },
        stories: [{ code: 'US-01', title: 'Download as PDF' }],
        ...extra,
      })
    );

  it('carries the builder’s acceptance of the whole feature', () => {
    expect(withFeature({ tested: true })?.tested).toBe(true);
    expect(withFeature({})?.tested).toBeUndefined();
    // Only a real true counts — an agent writing "yes" does not open a PR.
    expect(withFeature({ tested: 'yes' })?.tested).toBeUndefined();
  });

  it('keeps one pull request per repository that changed', () => {
    const urls = ['https://github.com/acme/api/pull/12', 'https://github.com/acme/web/pull/7'];
    expect(withFeature({ prUrls: urls })?.prUrls).toEqual(urls);
  });

  it('has no pull requests until one is raised', () => {
    expect(withFeature({})?.prUrls).toBeUndefined();
    expect(withFeature({ prUrls: [] })?.prUrls).toBeUndefined();
  });

  it('survives a round trip, so a raised PR is not lost on the next write', () => {
    const plan = withFeature({ tested: true, prUrls: ['https://github.com/acme/api/pull/12'] })!;
    const again = parsePlan(serializePlan(plan))!;
    expect(again.tested).toBe(true);
    expect(again.prUrls).toEqual(['https://github.com/acme/api/pull/12']);
  });
});

describe('featureLane', () => {
  const feature = (lanes: StoryLane[], extra: Record<string, unknown> = {}) =>
    parsePlan(
      JSON.stringify({
        version: 1,
        spec: { feature: 'Invoice export', overview: {}, scope: {}, requirements: {} },
        stories: lanes.map((lane, i) => ({ code: `US-0${i + 1}`, title: `Story ${i}`, lane })),
        ...extra,
      })
    );

  it('is done when the builder says so, even if no pull request was raised', () => {
    // Tying Done to the pull request left a feature stuck in Testing whenever
    // raising one failed — the case where the board most needs to make sense.
    expect(featureLane(feature(['done', 'done'], { tested: true }), false)).toBe('done');
  });

  it('is not done just because the stories are', () => {
    expect(featureLane(feature(['done', 'done']), false)).toBe('testing');
  });

  it('is done once its pull request is out, whatever the stories say', () => {
    // The PR being open is what done means for a feature; a story left in
    // Testing afterwards does not reopen it.
    const plan = feature(['done', 'testing'], { prUrls: ['https://github.com/a/b/pull/1'] });
    expect(featureLane(plan, false)).toBe('done');
  });

  it('is testing when every story has been accepted but no PR is out', () => {
    expect(featureLane(feature(['done', 'done']), false)).toBe('testing');
  });

  it('is coding while any story has been started', () => {
    expect(featureLane(feature(['todo', 'coding']), false)).toBe('coding');
    expect(featureLane(feature(['todo', 'done']), false)).toBe('coding');
  });

  it('is coding while a run is going, even before a story moves', () => {
    expect(featureLane(feature(['todo', 'todo']), true)).toBe('coding');
  });

  it('is todo when nothing has started', () => {
    expect(featureLane(feature(['todo', 'todo']), false)).toBe('todo');
  });

  it('treats a feature with no plan yet as todo', () => {
    expect(featureLane(null, false)).toBe('todo');
    expect(featureLane(feature([]), false)).toBe('todo');
  });
});
