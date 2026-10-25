import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every colour a component names must be a colour the theme defines.
 *
 * Tailwind class names are strings. The compiler does not see them, the
 * tests do not render them, and the build does not resolve them — so a
 * colour that does not exist produces no error anywhere and simply renders
 * as nothing. `bg-raised` reached a commit that way, and `text-stop` was
 * shipped in two releases: the "saved, not applied" badge was supposed to
 * be red and was whatever it inherited.
 *
 * This is the only place that can catch it, so it runs with the tests.
 */

const root = path.join(__dirname, '..', '..');
const config = fs.readFileSync(path.join(root, 'tailwind.config.cjs'), 'utf8');

/**
 * Colour names the theme adds, including nested ones like `go-bg`.
 *
 * Read by indentation rather than by a brace regex: `[^}]*` stops at the
 * first closing brace, which in a nested palette is the end of the FIRST
 * child object, so everything after it is misread. That cost a false
 * positive on `ink`, which is defined and was reported missing.
 */
function themeColours(): Set<string> {
  const names = new Set<string>();
  const stack: Array<{ key: string; indent: number }> = [];
  for (const raw of config.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
    // A whole palette on one line: `warn: { bg: '#..', text: '#..' },`
    const inline = /^\s*'?([A-Za-z][\w-]*)'?\s*:\s*\{(.+)\}\s*,?\s*$/.exec(line);
    if (inline && stack.some((s) => s.key === 'colors')) {
      names.add(inline[1]);
      for (const key of inline[2].matchAll(/'?([A-Za-z][\w-]*)'?\s*:/g)) {
        if (key[1] !== 'DEFAULT') names.add(`${inline[1]}-${key[1]}`);
      }
      continue;
    }
    const opens = /^\s*'?([A-Za-z][\w-]*)'?\s*:\s*\{/.exec(line);
    if (opens) {
      // Only names inside the colours block are colours.
      if (opens[1] === 'colors' || stack.some((s) => s.key === 'colors')) {
        if (opens[1] !== 'colors') {
          names.add(opens[1]);
          const parent = stack.find(
            (s) => s.key !== 'colors' && s.key !== 'theme' && s.key !== 'extend'
          );
          if (parent) names.add(`${parent.key}-${opens[1]}`);
        }
      }
      stack.push({ key: opens[1], indent });
      continue;
    }
    const leaf = /^\s*'?([A-Za-z][\w-]*)'?\s*:\s*'/.exec(line);
    if (leaf && stack.some((s) => s.key === 'colors')) {
      const parent = stack[stack.length - 1];
      if (parent && parent.key !== 'colors') {
        if (leaf[1] !== 'DEFAULT') names.add(`${parent.key}-${leaf[1]}`);
      } else {
        names.add(leaf[1]);
      }
    }
  }
  return names;
}

/**
 * Tailwind's own palette, which the theme extends rather than replaces, so
 * these remain legal. Listed rather than wildcarded: a typo in a family
 * name should still be caught.
 */
const DEFAULT_PALETTE = new Set([
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
]);

/**
 * Utilities that share a prefix with a colour utility and are not colours:
 * `border-t`, `text-left`, `border-dashed` and the rest.
 */
const NOT_A_COLOUR = new Set([
  't',
  'b',
  'l',
  'r',
  'x',
  'y',
  'e',
  's',
  '0',
  '2',
  '4',
  '8',
  'none',
  'solid',
  'dashed',
  'dotted',
  'double',
  'hidden',
  'left',
  'right',
  'center',
  'justify',
  'start',
  'end',
  'top',
  'bottom',
  'auto',
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  'balance',
  'pretty',
  'wrap',
  'nowrap',
  'clip',
  'ellipsis',
  'medium',
  'semibold',
  'bold',
  'normal',
  'mono',
  'sans',
  'white',
  'black',
  'transparent',
  'current',
  'inherit',
]);

const PREFIX =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|outline|accent|divide|placeholder|caret)-([a-z][a-z0-9-]*)/g;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) out.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

describe('colours a component names', () => {
  it('all resolve against the theme', () => {
    const known = themeColours();
    const unknown = new Map<string, Set<string>>();
    for (const file of sourceFiles()) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(PREFIX)) {
        const token = match[1];
        if (known.has(token) || NOT_A_COLOUR.has(token)) continue;
        if (DEFAULT_PALETTE.has(token.split('-')[0])) continue;
        // `border-l-2` and friends: a side or an axis with a width.
        if (/^[a-z]-\d+$/.test(token)) continue;
        const where = unknown.get(token) ?? new Set<string>();
        where.add(path.basename(file));
        unknown.set(token, where);
      }
    }
    const complaints = [...unknown.entries()].map(
      ([token, files]) => `${token} (${[...files].sort().join(', ')})`
    );
    expect(complaints, 'colours that resolve to nothing').toEqual([]);
  });

  it('knows the theme it is checking against', () => {
    // A check that found no colours would pass silently for ever.
    const known = themeColours();
    for (const token of ['go', 'go-bg', 'warn-text', 'danger', 'ink', 'muted', 'line-subtle']) {
      expect(known.has(token), token).toBe(true);
    }
    expect(known.has('stop')).toBe(false);
  });
});
