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
