import { describe, expect, it } from 'vitest';
import { parseMobilePreview } from './mobile';

describe('parseMobilePreview', () => {
  it('parses a mobile block with expo_url', () => {
    const yml = ['mobile:', '  kind: expo', '  expo_url: exp://192.168.1.10:8081'].join('\n');
    const preview = parseMobilePreview(yml);
    expect(preview).not.toBeNull();
    expect(preview?.kind).toBe('expo');
    expect(preview?.expoUrl).toBe('exp://192.168.1.10:8081');
  });

  it('returns null without a mobile block', () => {
    expect(parseMobilePreview('app:\n  name: x')).toBeNull();
    expect(parseMobilePreview(null)).toBeNull();
  });
});
