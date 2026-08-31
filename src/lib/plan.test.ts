import { describe, expect, it } from 'vitest';
import { canMove, itemId, parsePlan, slugForFeature, snapEstimate, uncoveredItems } from './plan';

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
