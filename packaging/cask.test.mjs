import { describe, expect, it } from 'vitest';
import { APP_BUNDLE, renderCask } from './cask.mjs';

const SHA = 'a'.repeat(64);

describe('renderCask', () => {
  it('pins the exact version and checksum it was given', () => {
    const cask = renderCask({ version: '1.0.0-beta.18', sha256: SHA });
    expect(cask).toContain('version "1.0.0-beta.18"');
    expect(cask).toContain(`sha256 "${SHA}"`);
    expect(cask).toContain(`app "${APP_BUNDLE}"`);
  });

  it('leaves the version to Homebrew to interpolate, so the url follows upgrades', () => {
    // #{version} is Ruby, evaluated by brew — writing the number in twice is
    // how a cask ends up downloading the old dmg under the new version.
    const cask = renderCask({ version: '1.0.0-beta.18', sha256: SHA });
    expect(cask).toContain('/releases/download/v#{version}/mvpfy-by-feature1-#{version}.dmg');
    expect(cask).not.toContain('download/v1.0.0-beta.18');
  });

  it('never clears the quarantine flag on the user behalf', () => {
    // An unsigned build is refused by macOS on first launch. Stripping the
    // flag from a postflight would fix that silently, which is exactly why it
    // is not here: --no-quarantine stays the installer's own decision.
    expect(renderCask({ version: '1.0.0', sha256: SHA })).not.toMatch(/postflight do/);
  });

  it('will not zap the directory holding people code', () => {
    // ~/.mvpfy carries cloned projects and worktrees with uncommitted work.
    const cask = renderCask({ version: '1.0.0', sha256: SHA });
    const zap = cask.slice(cask.indexOf('zap trash:'));
    expect(zap).toMatch(/zap trash:/);
    // Only what the app itself wrote, under Library.
    for (const line of zap.split('\n').filter((l) => l.includes('"~/'))) {
      expect(line).toMatch(/"~\/Library\//);
    }
  });

  it('refuses a version or checksum it cannot vouch for', () => {
    expect(() => renderCask({ version: 'v1.0.0', sha256: SHA })).toThrow(/Not a version/);
    expect(() => renderCask({ version: '1.0.0', sha256: 'deadbeef' })).toThrow(/64 lowercase hex/);
    expect(() => renderCask({ version: '1.0.0', sha256: SHA.toUpperCase() })).toThrow();
  });
});
