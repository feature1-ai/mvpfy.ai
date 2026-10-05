import { describe, expect, it } from 'vitest';
import {
  featureImplemented,
  featurePulled,
  featurePushed,
  quotaBack,
  quotaRanOut,
  quotaStillOut,
} from './notices';

describe('what a notification says', () => {
  it('tells the builder the feature is theirs to try, not that a run exited', () => {
    const n = featureImplemented('Invoice reminders', 6);
    expect(n.title).toBe('Invoice reminders is ready to test');
    expect(n.body).toContain('All 6 stories');
    expect(featureImplemented('Paging', 1).body).toContain('Its story is implemented');
  });

  it('leads with nothing being wrong when the allowance runs out', () => {
    // Read as an ordinary failure, this is the one that sends somebody
    // debugging code that was never broken.
    const n = quotaRanOut('Invoice reminders', new Date('2026-10-05T13:00:00Z'));
    expect(n.body).toMatch(/nothing is wrong with the code/i);
    expect(n.body).toMatch(/carries on by itself/i);
    // And it says when, because the agent said so.
    expect(n.body).toMatch(/comes back at/i);
  });

  it('says only what it knows when the agent gave no time', () => {
    expect(quotaRanOut('Paging', null).body).not.toMatch(/comes back at/i);
  });

  it('names the story it is picking back up', () => {
    expect(quotaBack('Paging', 'US-03').body).toContain('US-03');
    expect(quotaBack('Paging', null).body).toMatch(/rest of the feature/i);
  });

  it('says what to do when the wait did not work', () => {
    expect(quotaStillOut('Paging').body).toMatch(/Continue feature/);
  });

  it('covers both directions of Feature1', () => {
    expect(featurePulled('Paging', 4, true).body).toMatch(/Pulled from Feature1, with 4 stories/);
    // Planned here rather than pulled: the same moment, said truthfully.
    expect(featurePulled('Paging', 4).body).toMatch(/Its spec is written/);
    expect(featurePulled('Paging', 0).body).toMatch(/ready to read/i);
    expect(featurePushed('Paging').title).toBe('Paging is in Feature1');
  });

  it('never shows an empty name', () => {
    expect(featureImplemented('  ', 2).title).toBe('Your feature is ready to test');
  });
});
