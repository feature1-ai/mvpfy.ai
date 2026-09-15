#!/usr/bin/env node
/**
 * Render the cask for a published release and print it.
 *
 * Reads the version and the .dmg checksum from the GitHub release itself
 * rather than being told them: the checksum has to be of the file people will
 * actually download, and a number typed in by hand is a number that can be
 * wrong. Run as: node packaging/render-cask.mjs v1.0.0-beta.18
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCask } from './cask.mjs';

const tag = process.argv[2];
if (!tag) {
  console.error('usage: node packaging/render-cask.mjs <release tag, e.g. v1.0.0-beta.18>');
  process.exit(2);
}
const version = tag.replace(/^v/, '');
const asset = `mvpfy-by-feature1-${version}.dmg`;

const dir = mkdtempSync(path.join(tmpdir(), 'mvpfy-cask-'));
try {
  execFileSync('gh', ['release', 'download', tag, '--pattern', asset, '--dir', dir], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const sha256 = createHash('sha256')
    .update(readFileSync(path.join(dir, asset)))
    .digest('hex');
  process.stdout.write(renderCask({ version, sha256 }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
