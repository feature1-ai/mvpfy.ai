import { CliName, CliStatus, REQUIRED_CLIS } from '../../shared/types';
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

// In-app sign-in for tools whose login flows survive without a TTY. The
// output streams to the renderer so device codes/URLs are visible.
const LOGIN_COMMANDS: Record<string, string> = {
  gh: 'gh auth login --hostname github.com --git-protocol https --web',
  codex: 'codex login',
};

/** The shell command that signs `tool` in from inside the app. */
export function loginCommand(tool: string): string {
  const command = LOGIN_COMMANDS[tool];
  if (!command) throw new Error(`No in-app sign-in for "${tool}"`);
  return command;
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
