import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLinkedRoots } from '../paths';
import { addDesignImages, designImagePaths, readDesignImage, removeDesignImage } from './design';

afterEach(() => setLinkedRoots([]));

const workspace = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvpfy-design-'));
  setLinkedRoots([dir]);
  return dir;
};
const png = (dir: string, name: string): string => {
  const file = path.join(dir, name);
  // A one-pixel PNG, so the bytes are a real image rather than a name.
  fs.writeFileSync(
    file,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  return file;
};

describe('addDesignImages', () => {
  it('copies the design in, so it survives somebody tidying their Downloads', () => {
    const ws = workspace();
    const src = png(ws, 'screen.png');
    expect(addDesignImages(ws, '', 'paging', [src])).toEqual(['screen.png']);
    expect(fs.existsSync(path.join(ws, 'mvpfy-design/paging/screen.png'))).toBe(true);
  });

  it('keeps both when two designs share a name, which is the normal case', () => {
    // Two screens exported as screenshot.png is not a mistake, and silently
    // replacing the first would lose a design nobody knew was gone.
    const ws = workspace();
    const a = png(ws, 'screenshot.png');
    expect(addDesignImages(ws, '', 'paging', [a])).toEqual(['screenshot.png']);
    expect(addDesignImages(ws, '', 'paging', [a])).toEqual(['screenshot-2.png']);
  });

  it('refuses a file that is not an image mvpfy can attach', () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws, 'notes.pdf'), 'x');
    expect(() => addDesignImages(ws, '', 'paging', [path.join(ws, 'notes.pdf')])).toThrow(
      /not an image/
    );
  });

  it('refuses a workspace it does not own', () => {
    setLinkedRoots([]);
    expect(() => addDesignImages('/etc', '', 'paging', [])).toThrow(/managed and linked/);
  });
});

describe('designImagePaths', () => {
  it('hands back only what is actually on disk', () => {
    // A plan can name a design somebody deleted by hand. Passing that path to
    // an agent produces a file-not-found halfway through implementing.
    const ws = workspace();
    addDesignImages(ws, '', 'paging', [png(ws, 'a.png')]);
    expect(designImagePaths(ws, '', 'paging', ['a.png', 'gone.png'])).toHaveLength(1);
  });

  it('cannot be walked out of the design folder by its name', () => {
    const ws = workspace();
    addDesignImages(ws, '', 'paging', [png(ws, 'a.png')]);
    expect(designImagePaths(ws, '', 'paging', ['../../../etc/passwd'])).toEqual([]);
  });
});

describe('readDesignImage', () => {
  it('reads one back as something the renderer can show', () => {
    const ws = workspace();
    addDesignImages(ws, '', 'paging', [png(ws, 'a.png')]);
    expect(readDesignImage(ws, '', 'paging', 'a.png')).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses one too large to cross IPC as text', () => {
    // It arrives as base64, so a big screenshot becomes a much bigger string.
    const ws = workspace();
    addDesignImages(ws, '', 'paging', [png(ws, 'a.png')]);
    expect(readDesignImage(ws, '', 'paging', 'a.png', 1)).toBeNull();
  });

  it('says nothing for one that is not there', () => {
    expect(readDesignImage(workspace(), '', 'paging', 'gone.png')).toBeNull();
  });
});

describe('removeDesignImage', () => {
  it('removes it from disk as well as from the plan', () => {
    const ws = workspace();
    addDesignImages(ws, '', 'paging', [png(ws, 'a.png')]);
    removeDesignImage(ws, '', 'paging', 'a.png');
    expect(fs.existsSync(path.join(ws, 'mvpfy-design/paging/a.png'))).toBe(false);
  });

  it('cannot be aimed outside the design folder', () => {
    const ws = workspace();
    const outside = path.join(ws, 'keep.txt');
    fs.writeFileSync(outside, 'x');
    removeDesignImage(ws, '', 'paging', '../keep.txt');
    expect(fs.existsSync(outside)).toBe(true);
  });
});
