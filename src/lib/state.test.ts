import { describe, expect, it } from 'vitest';
import { nextPortBlock, PORT_BLOCK } from './state';

describe('nextPortBlock', () => {
  it('starts at 4100 when there are no projects', () => {
    expect(nextPortBlock([])).toBe(4100);
  });

  it("never hands out a port inside another project's block", () => {
    // A project on 4101 publishes its API on 4102: the next project was
    // given 4102 and could not run beside it.
    for (const bases of [[4101], [4100, 4101], [4100, 4101, 4112], [4110], [4119]]) {
      const next = nextPortBlock(bases);
      for (const base of bases) {
        expect(next >= base + PORT_BLOCK, `${next} after ${bases.join(',')}`).toBe(true);
      }
    }
  });

  it('starts on a round number', () => {
    expect(nextPortBlock([4101]) % PORT_BLOCK).toBe(0);
    expect(nextPortBlock([4112]) % PORT_BLOCK).toBe(0);
  });

  it('hands out the very next block when the last one is round', () => {
    expect(nextPortBlock([4100])).toBe(4110);
    expect(nextPortBlock([4100, 4110])).toBe(4120);
  });
});
