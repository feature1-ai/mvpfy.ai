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
