import { describe, expect, it } from 'vitest';
import { commandFrom } from './config';
import { parseReview, planOf, reviewLine, reviewPrompt } from './review';

const snapshot = {
  type: 'feature',
  id: 'f1',
  code: 'THA-F-11',
  title: 'Publish stories safely',
  description: 'Render approved stories publicly.',
  stories: [
    {
      type: 'story',
      id: 's1',
      code: 'THA-US-32',
      title: 'Operate a capped pilot',
      description: 'As a moderator, I want pause controls.',
      acceptanceCriteria: [{ id: 'a1', text: 'Pausing stops new drafts' }],
    },
    { type: 'story', id: 's2', code: 'THA-US-39', title: 'Withdraw safely', description: '' },
  ],
} as never;

describe('what a build changed, and what to try', () => {
  it("asks from the build's own plan, saying where criteria are missing", () => {
    const prompt = reviewPrompt(
      planOf(snapshot),
      [
        { folder: 'api', base: 'main', changed: true },
        { folder: 'web', base: 'develop', changed: false },
      ],
      '/w/review.json',
      ['NUXT_X=1']
    );
    expect(prompt).toContain('THA-F-11 — Publish stories safely');
    expect(prompt).toContain('- Pausing stops new drafts');
    expect(prompt).toContain('Acceptance criteria: NONE were recorded for this story.');
    expect(prompt).toContain('git -C api diff --stat origin/main...HEAD');
    expect(prompt).not.toContain('git -C web');
    expect(prompt).toContain('NUXT_X=1');
    expect(prompt).toContain('/w/review.json');
    expect(prompt).toMatch(/READ-ONLY/);
  });

  it('a single story is its own plan', () => {
    const story = planOf({ type: 'story', id: 's', code: 'US-1', title: 'One' } as never);
    expect(story.stories).toHaveLength(1);
    expect(story.stories[0]?.code).toBe('US-1');
  });

  it('keeps what is well formed, cut to size, and drops the rest', () => {
    const review = parseReview(
      'Here it is:\n```json\n' +
        JSON.stringify({
          summary: 'Moderators can pause the pilot.',
          changes: [
            { area: 'Admin', what: 'A safety page' },
            { area: '', what: 'no area' },
          ],
          tests: [
            {
              story: 'THA-US-32',
              title: 'Pause drafts',
              where: '/admin/operations',
              steps: ['Open the page', 'Press Pause'],
              expect: 'New drafts are refused',
            },
            { story: 'null', title: 'No steps or result' },
            { story: null, title: 'x'.repeat(2000), where: 'null', steps: [], expect: 'y' },
          ],
          notOnLink: ['Google sign-in has no keys on a link', 3],
          planGaps: ['THA-US-39 has no acceptance criteria'],
        }) +
        '\n```'
    );
    expect(review?.summary).toBe('Moderators can pause the pilot.');
    expect(review?.changes).toEqual([{ area: 'Admin', what: 'A safety page' }]);
    expect(review?.tests).toHaveLength(2);
    expect(review?.tests[1]).toMatchObject({ story: null, where: null });
    expect(review?.tests[1]?.title).toHaveLength(600);
    expect(review?.notOnLink).toEqual(['Google sign-in has no keys on a link']);
    expect(reviewLine(review!)).toMatch(/^REVIEW \{/);
    expect(reviewLine(review!)).not.toContain('\n');
  });

  it('is nothing when the agent wrote nothing usable', () => {
    expect(parseReview('I could not do it.')).toBeNull();
    expect(parseReview('{"tests": []}')).toBeNull();
  });

  it('takes an execution id on the command line', () => {
    const id = '438a12f7-c662-4597-a024-fc32be4bbf72';
    expect(commandFrom(['node', 'worker', 'review', id])).toEqual({
      name: 'review',
      execution: id,
    });
  });
});
