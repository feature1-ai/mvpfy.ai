import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The team's design principles and architecture, as mvpfy cloud keeps them.
 *
 * Written by mvpfy cloud to the worker's volume before each task, and read
 * here fresh for every story, so an edit made while a feature is building
 * reaches the next story. Absent is ordinary: most products have none.
 */

export const GUIDANCE_FILE = 'guidance.md';
/** More than any reasonable guidance; a brief is not the place for a book. */
const MAX_BYTES = 64 * 1024;

export function readGuidance(root: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(root, GUIDANCE_FILE), 'utf8').slice(0, MAX_BYTES).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
