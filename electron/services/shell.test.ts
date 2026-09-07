import { describe, expect, it } from 'vitest';
import { cdTo, IS_WIN, parseRegistryPath, shellQuote, winShellArgs } from './shell';

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

describe('parseRegistryPath', () => {
  const output = (value: string, type = 'REG_EXPAND_SZ') =>
    `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${type}    ${value}\r\n\r\n`;

  it('reads the directories a user added to PATH', () => {
    const dirs = parseRegistryPath(output('C:\\Users\\mudas\\.local\\bin;C:\\tools'));
    expect(dirs).toEqual(['C:\\Users\\mudas\\.local\\bin', 'C:\\tools']);
  });

  it('expands %VAR% references, which is why the value is REG_EXPAND_SZ', () => {
    process.env.MVPFY_TEST_APPDATA = 'C:\\Users\\mudas\\AppData\\Roaming';
    try {
      expect(parseRegistryPath(output('%MVPFY_TEST_APPDATA%\\npm'))).toEqual([
        'C:\\Users\\mudas\\AppData\\Roaming\\npm',
      ]);
    } finally {
      delete process.env.MVPFY_TEST_APPDATA;
    }
  });

  it('leaves an unset variable alone rather than emitting a broken path', () => {
    expect(parseRegistryPath(output('%NOPE_NOT_SET%\\bin'))).toEqual(['%NOPE_NOT_SET%\\bin']);
  });

  it('handles REG_SZ and drops empty segments from a trailing semicolon', () => {
    expect(parseRegistryPath(output('C:\\a;;C:\\b;', 'REG_SZ'))).toEqual(['C:\\a', 'C:\\b']);
  });

  it('does not mistake PATHEXT for PATH', () => {
    const stdout =
      '\r\nHKEY_CURRENT_USER\\Environment\r\n    PATHEXT    REG_SZ    .COM;.EXE;.CMD\r\n\r\n';
    expect(parseRegistryPath(stdout)).toEqual([]);
  });

  it('returns nothing when the value is absent', () => {
    expect(parseRegistryPath('ERROR: The system was unable to find the specified value.')).toEqual(
      []
    );
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
