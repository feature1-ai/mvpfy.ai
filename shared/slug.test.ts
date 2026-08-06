import { describe, expect, it } from 'vitest';
import { slugFromRepoUrl } from './slug';

describe('slugFromRepoUrl', () => {
  it('slugs https URLs', () => {
    expect(slugFromRepoUrl('https://github.com/org/My-Repo.git')).toBe('my-repo');
  });

  it('slugs ssh URLs', () => {
    expect(slugFromRepoUrl('git@github.com:org/backend.git')).toBe('backend');
  });

  it('slugs local paths', () => {
    expect(slugFromRepoUrl('/Users/me/projects/Jarshare')).toBe('jarshare');
    expect(slugFromRepoUrl('~/projects/app/')).toBe('app');
  });

  it('falls back for degenerate input', () => {
    expect(slugFromRepoUrl('///')).toBe('project');
  });
});
