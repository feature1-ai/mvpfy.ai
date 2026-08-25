import { describe, expect, it } from 'vitest';
import { IS_WIN, shellQuote } from './shell';

describe('shellQuote', () => {
  describe.runIf(!IS_WIN)('posix', () => {
    it('wraps plain values in single quotes', () => {
      expect(shellQuote('hello')).toBe("'hello'");
      expect(shellQuote('/Users/pm/projects/my app')).toBe("'/Users/pm/projects/my app'");
    });

    it('neutralizes shell metacharacters', () => {
      expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
      expect(shellQuote('a && b; c | d > e')).toBe("'a && b; c | d > e'");
      expect(shellQuote('`whoami`')).toBe("'`whoami`'");
    });

    it('escapes embedded single quotes', () => {
      expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
      expect(shellQuote("'; rm -rf /; '")).toBe("''\\''; rm -rf /; '\\'''");
    });

    it('quotes the empty string', () => {
      expect(shellQuote('')).toBe("''");
    });
  });

  describe.runIf(IS_WIN)('windows', () => {
    it('wraps values in double quotes and doubles embedded quotes', () => {
      expect(shellQuote('hello')).toBe('"hello"');
      expect(shellQuote('say "hi"')).toBe('"say ""hi"""');
    });
  });
});
