import { CliName, CliStatus, REQUIRED_CLIS } from '../../shared/types';
import { terminalCommand } from './install';
import { IS_WIN, spawnShellSync } from './shell';

/** Detection of required CLIs and their sign-in state. */

const AUTH_PROBES: Partial<Record<CliName, string>> = {
  gh: 'gh auth status',
  claude: 'claude auth status',
  codex: 'codex login status',
};

function authCheck(name: CliName, found: boolean): boolean | null {
  const probe = AUTH_PROBES[name];
  if (!probe || !found) return probe ? false : null;
  const result = spawnShellSync(probe, { encoding: 'utf8', timeout: 20_000 });
  if (name === 'claude') {
    return result.status === 0 && /"loggedIn":\s*true/.test(result.stdout);
  }
  return result.status === 0;
}

/**
 * Sign-in started from inside mvpfy. Same split as the installers: gh and
 * codex survive without a TTY, so their output streams into Settings; Claude
 * Code's login is an interactive flow, so it goes to Terminal.app rather than
 * dying silently against a pipe.
 */
const LOGIN_COMMANDS: Record<string, { command: string; mode: 'in-app' | 'terminal' }> = {
  // `gh auth login` signs gh in but only wires git's credential helper when
  // asked. Without setup-git, `git push` still fails later — mid-run, inside
  // an agent — even though Settings shows GitHub as connected.
  gh: {
    command: 'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git',
    mode: 'in-app',
  },
  codex: { command: 'codex login', mode: 'in-app' },
  claude: { command: 'claude auth login', mode: 'terminal' },
};

/** The shell command that signs `tool` in from inside the app. */
export function loginCommand(tool: string): string {
  const entry = LOGIN_COMMANDS[tool];
  if (!entry) throw new Error(`No in-app sign-in for "${tool}"`);
  if (entry.mode === 'terminal') {
    if (process.platform !== 'darwin') {
      throw new Error(`Run "${entry.command}" in a terminal, then re-check`);
    }
    return terminalCommand(entry.command);
  }
  return entry.command;
}

/** True when signing this tool in opens Terminal instead of streaming in-app. */
export function loginOpensTerminal(tool: string): boolean {
  return LOGIN_COMMANDS[tool]?.mode === 'terminal';
}

export function cliCheck(): CliStatus[] {
  return REQUIRED_CLIS.map((name) => {
    const locator = IS_WIN ? `where ${name}` : `command -v ${name}`;
    const result = spawnShellSync(locator, { encoding: 'utf8', timeout: 10_000 });
    const found = result.status === 0 && result.stdout.trim().length > 0;
    return {
      name,
      found,
      path: found ? result.stdout.trim().split('\n')[0] : null,
      authenticated: authCheck(name, found),
    };
  });
}
