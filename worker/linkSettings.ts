import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Settings a test link needs that the product leaves off by default — most
 * often a feature flag around exactly the change being tried.
 *
 * Without this a link could start a change nobody could reach: a story built
 * behind a flag the recipe turns off. Two sources, both plain `KEY=value`:
 *
 *   • the build itself, which is asked to name any it needs as
 *     `TEST_LINK_SETTING KEY=value` in its last message; the worker logs each
 *     as `link setting: KEY=value` for mvpfy cloud to pass to that build's link;
 *   • the workspace, whose developers can set them once in mvpfy cloud.
 *
 * mvpfy cloud leaves the merged list on the worker's volume, and `preview`
 * lays it over the recipe's env file. They are a test copy's settings, never
 * credentials: a value that looks like one is refused.
 */

export const LINK_SETTINGS_FILE = 'link-settings.env';
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX = 50;

export interface LinkSetting {
  key: string;
  value: string;
}

/** Looks like a secret, which a test link setting must never be. */
function secretLike(key: string, value: string): boolean {
  return (
    /SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE/.test(key) || /^(gh[pousr]_|sk-|github_pat_)/.test(value)
  );
}

export function parseLinkSettings(text: string): LinkSetting[] {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!KEY.test(key) || value.length > 500 || /[\r\n\0]/.test(value) || secretLike(key, value))
      continue;
    out.set(key, value);
    if (out.size >= MAX) break;
  }
  return [...out].map(([key, value]) => ({ key, value }));
}

/** What a build asked for in its last message. */
export function requestedLinkSettings(agentOutput: string): LinkSetting[] {
  const found: string[] = [];
  for (const match of agentOutput.matchAll(
    /TEST_LINK_SETTING\s+([A-Z][A-Z0-9_]{0,63})=([^\s"\\`]{1,200})/g
  )) {
    found.push(`${match[1]}=${match[2]}`);
  }
  return parseLinkSettings(found.join('\n'));
}

export function readLinkSettings(root: string): LinkSetting[] {
  try {
    return parseLinkSettings(fs.readFileSync(path.join(root, LINK_SETTINGS_FILE), 'utf8'));
  } catch {
    return [];
  }
}

/** Sets each in an env file, replacing a line that sets it already, adding it otherwise. */
export function applyLinkSettings(envFile: string, settings: LinkSetting[]): void {
  if (settings.length === 0) return;
  let text = '';
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    // A recipe without an env file gets one.
  }
  const lines = text
    .replace(/\n+$/, '')
    .split('\n')
    .filter((l, i, all) => l || i < all.length - 1);
  for (const { key, value } of settings) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(
    envFile,
    `${lines.join('\n').replace(/\n+$/, '')}\n# Set for this test link by mvpfy\n`
  );
}
