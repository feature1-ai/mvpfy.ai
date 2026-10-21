import { describe, expect, it } from 'vitest';
import { DEFAULT_STACK } from '../../shared/types';
import { implementGrounding, specGrounding, stackFor } from './grounding';

describe('stackFor', () => {
  it('uses what Settings says, and the default when it says nothing', () => {
    expect(stackFor('Django + htmx')).toBe('Django + htmx');
    expect(stackFor('   ')).toBe(DEFAULT_STACK);
    expect(stackFor(null)).toBe(DEFAULT_STACK);
  });
});

describe('specGrounding', () => {
  it('keeps the original instruction for a product that exists', () => {
    // The case mvpfy was built for must not change: this is what shipped.
    expect(specGrounding({ empty: false })).toMatch(/study the existing product/i);
    expect(specGrounding({ empty: false })).not.toMatch(/no product/i);
  });

  it('tells an empty workspace it is empty, rather than leaving it to invent', () => {
    const out = specGrounding({ empty: true });
    expect(out).toMatch(/no product in it yet/i);
    expect(out).toMatch(/do not write as though there are/i);
  });

  it('keeps the stack out of what the product manager reads', () => {
    // The spec is read by someone who did not choose the stack and should not
    // have to review it — the agent needs it, the document does not.
    expect(specGrounding({ empty: true })).toMatch(/do not name it in the spec/i);
  });
});

describe('implementGrounding', () => {
  it('still says match the patterns when there are patterns', () => {
    expect(implementGrounding({ empty: false })).toMatch(/match its patterns/i);
  });

  it('says establish them when there are none, and names the stack', () => {
    const out = implementGrounding({ empty: true, stack: 'Rails + Postgres' });
    expect(out).toMatch(/no patterns to match and you are setting them/i);
    expect(out).toContain('Rails + Postgres');
  });

  it('falls back to the default stack rather than leaving the choice open', () => {
    // "Pick whatever you like" is how two projects from one person end up on
    // different stacks for no visible reason.
    expect(implementGrounding({ empty: true })).toContain(DEFAULT_STACK);
  });
});

describe('implementGrounding and the feature map', () => {
  it('sends a story to the map instead of searching the workspace again', () => {
    // The point of the map: six stories in a feature used to study the same
    // codebase six times over, each paying to find where things are.
    const out = implementGrounding({ empty: false, notesFile: 'mvpfy-notes.billing.md' });
    expect(out).toMatch(/mvpfy-notes\.billing\.md/);
    expect(out).toMatch(/instead of searching/i);
  });

  it('still makes the story read the code the map points at', () => {
    // A map that replaced reading would be a map that implemented from
    // memory. It replaces the search, not the reading.
    const out = implementGrounding({ empty: false, notesFile: 'mvpfy-notes.billing.md' });
    expect(out).toMatch(/read those properly/i);
    expect(out).toMatch(/trust the code/i);
  });

  it('keeps the old instruction for a feature planned before maps existed', () => {
    // Those features still have to implement, and have no file to read.
    const out = implementGrounding({ empty: false });
    expect(out).toMatch(/match its patterns/i);
    expect(out).not.toMatch(/mvpfy-notes/);
  });

  it('asks the first story in an empty repo to write the conventions down', () => {
    // Story one chooses them; every story after is told to match them, which
    // only works if they were recorded somewhere.
    const out = implementGrounding({ empty: true, notesFile: 'mvpfy-notes.billing.md' });
    expect(out).toMatch(/write what you chose into mvpfy-notes\.billing\.md/i);
  });

  it('leaves an empty repo alone when there is no map to write to', () => {
    expect(implementGrounding({ empty: true })).not.toMatch(/mvpfy-notes/);
  });
});
