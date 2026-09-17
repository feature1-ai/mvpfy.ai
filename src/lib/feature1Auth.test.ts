import { describe, expect, it } from 'vitest';
import { needsFeature1SignIn } from './feature1Auth';

describe('needsFeature1SignIn', () => {
  it('spots the message the server actually sends', () => {
    // Sent as a SUCCESSFUL tool result, which is why the run finishes green
    // and nothing in mvpfy notices.
    expect(
      needsFeature1SignIn(
        '⚠️ Not authenticated. Use "browser_login" to open the browser login page, or use the "login" tool with Feature1 credentials.'
      )
    ).toBe(true);
  });

  it('spots the browser_login handoff on its own', () => {
    expect(
      needsFeature1SignIn('Open this URL to sign in to Feature1 for this MCP server:\n\nhttps://x')
    ).toBe(true);
  });

  it('leaves an ordinary run alone', () => {
    expect(needsFeature1SignIn('Read the feature. Wrote mvpfy-plan.paging.json.')).toBe(false);
    expect(needsFeature1SignIn('')).toBe(false);
    expect(needsFeature1SignIn(null)).toBe(false);
  });

  it('does not fire on the word authenticated used normally', () => {
    expect(needsFeature1SignIn('gh reports authenticated to github.com')).toBe(false);
  });
});
