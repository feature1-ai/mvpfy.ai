import { describe, expect, it } from 'vitest';
import { cdTo, IS_WIN, shellQuote, winShellArgs } from './shell';

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

// Runs on every platform on purpose: the Windows quoting bug this guards
// against was invisible to a macOS-only test run.
describe('winShellArgs', () => {
  /** What cmd.exe /s does to the command line: drop the outer quote pair. */
  const afterCmdParses = (args: string[]): string => args[3].replace(/^"|"$/g, '');

  it('hands cmd.exe the command with its quoting intact', () => {
    const command = 'git clone "https://example.com/a.git" "C:\\Users\\pm\\.mvpfy\\projects\\a"';
    expect(afterCmdParses(winShellArgs(command))).toBe(command);
  });

  it('keeps quote characters out of a clone destination path', () => {
    const dest = 'C:\\Users\\mudas\\.mvpfy\\projects\\satorixr-backend-stack-2\\satorixr-backend';
    const parsed = afterCmdParses(winShellArgs(`git clone "https://x/y.git" "${dest}"`));
    // The literal path token cmd passes on must be the path and nothing else.
    expect(parsed.endsWith(`"${dest}"`)).toBe(true);
    expect(parsed).not.toContain('\\"');
  });

  it('passes /d and /s so no autorun script or stray quote interferes', () => {
    expect(winShellArgs('echo hi').slice(0, 3)).toEqual(['/d', '/s', '/c']);
  });
});

describe('cdTo', () => {
  it('quotes the directory', () => {
    expect(cdTo('/Users/pm/my app')).toContain(shellQuote('/Users/pm/my app'));
  });

  it.runIf(IS_WIN)('switches drive as well as directory on windows', () => {
    expect(cdTo('D:\\work\\repo')).toBe('cd /d "D:\\work\\repo"');
  });

  it.runIf(!IS_WIN)('is a plain cd on posix, where /d is not a flag', () => {
    expect(cdTo('/Users/pm/repo')).toBe("cd '/Users/pm/repo'");
  });
});
