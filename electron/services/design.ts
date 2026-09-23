import * as fs from 'node:fs';
import * as path from 'node:path';
import { DESIGN_IMAGE_EXTENSIONS, designDirFor } from '../../shared/types';
import { isAllowedWorkspace } from '../paths';

/**
 * The pictures of what a feature is supposed to look like.
 *
 * Copied into the workspace rather than referenced where they sit, for two
 * reasons: the agent runs with the workspace as its working directory and can
 * open anything inside it, and a design living in somebody's Downloads folder
 * stops existing the moment they tidy up.
 */

/** Refuse a name that could climb out of the design folder. */
function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]+/g, '-');
  const ext = path.extname(base).slice(1).toLowerCase();
  if (!DESIGN_IMAGE_EXTENSIONS.includes(ext)) {
    throw new Error(`${name} is not an image mvpfy can attach`);
  }
  return base;
}

function designRoot(workspacePath: string, configDir: string, slug: string): string {
  const resolved = path.resolve(workspacePath);
  if (!isAllowedWorkspace(resolved)) {
    throw new Error('Designs are restricted to managed and linked project directories');
  }
  return path.join(resolved, configDir, designDirFor(slug));
}

/** Copy chosen images in, returning the names the plan should record. */
export function addDesignImages(
  workspacePath: string,
  configDir: string,
  slug: string,
  sources: string[]
): string[] {
  const dir = designRoot(workspacePath, configDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const added: string[] = [];
  for (const source of sources) {
    const name = safeName(source);
    // Never silently replace a design already attached under the same name —
    // two screens called screenshot.png is the normal case, not a mistake.
    let target = path.join(dir, name);
    let n = 2;
    while (fs.existsSync(target)) {
      const ext = path.extname(name);
      target = path.join(dir, `${path.basename(name, ext)}-${n++}${ext}`);
    }
    fs.copyFileSync(path.resolve(source), target);
    added.push(path.basename(target));
  }
  return added;
}

/** Remove one, by the name the plan recorded. */
export function removeDesignImage(
  workspacePath: string,
  configDir: string,
  slug: string,
  name: string
): void {
  const dir = designRoot(workspacePath, configDir, slug);
  const target = path.join(dir, path.basename(name));
  // basename already confines it; asserted because this reaches rm.
  if (path.dirname(target) !== dir) throw new Error('Refusing to remove outside the design folder');
  fs.rmSync(target, { force: true });
}

/**
 * One image as a data URL, for showing it back.
 *
 * The renderer cannot read the disk, and a file:// image would depend on how
 * the window happens to be loaded. Capped, because this crosses IPC as text
 * and a 40MB screenshot would arrive as a 54MB string.
 */
export function readDesignImage(
  workspacePath: string,
  configDir: string,
  slug: string,
  name: string,
  maxBytes = 8 * 1024 * 1024
): string | null {
  const dir = designRoot(workspacePath, configDir, slug);
  const target = path.join(dir, path.basename(name));
  try {
    if (fs.statSync(target).size > maxBytes) return null;
    const ext = path.extname(target).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${fs.readFileSync(target).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Absolute paths of a feature's images, for handing to an agent. */
export function designImagePaths(
  workspacePath: string,
  configDir: string,
  slug: string,
  names: string[]
): string[] {
  const dir = designRoot(workspacePath, configDir, slug);
  return names.map((n) => path.join(dir, path.basename(n))).filter((p) => fs.existsSync(p));
}
