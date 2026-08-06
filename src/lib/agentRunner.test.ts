import { describe, expect, it } from 'vitest';
import { buildShipFeaturePrompt, extractPrUrl } from './agentRunner';

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
