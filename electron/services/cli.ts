import { CliName, CliStatus, REQUIRED_CLIS } from '../../shared/types';
import { terminalCommand } from './install';
import { IS_WIN, resolveWindowsPath, spawnShellSync } from './shell';

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

/**
 * Model names an agent CLI advertises in its own --help.
 *
 * Neither CLI can list its models — there is no `claude models` and no
 * `[possible values]` on codex's --model — but claude's help text names the
 * current aliases in prose, and that text ships with the installed version.
 * Reading it beats a list hardcoded here, which is wrong the moment a model
 * is added. Anything unparseable yields nothing, and the caller falls back to
 * letting the user type a name.
 */
export function parseModelsFromHelp(help: string): string[] {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => /^\s*(-\w,\s*)?--model\b/.test(l));
  if (start === -1) return [];
  const block: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    // The description is the indented continuation; the next option ends it.
    if (/^\s*-\w?[\w-]*,?\s*--/.test(lines[i]) || lines[i].trim() === '') break;
    block.push(lines[i]);
  }
  const quoted = block.join(' ').match(/'([A-Za-z][A-Za-z0-9.-]*)'/g) ?? [];
  return [...new Set(quoted.map((q) => q.slice(1, -1)))];
}

/** Ask an agent CLI which models it will accept. Empty when it will not say. */
export function agentModels(agent: CliName): string[] {
  // codex documents --model on its `exec` subcommand, not at the top level.
  const help = agent === 'claude' ? 'claude --help' : 'codex exec --help';
  // Piped into cat on purpose: claude writes its help to a pipe and exits
  // without waiting for the drain, so reading it directly returns a few
  // kilobytes cut off mid-line — and --model sorts past the cut. cmd.exe has
  // no cat, and gets the plain form; a short read there simply yields nothing
  // and the user types the name instead.
  const probe = IS_WIN ? `${help} 2>&1` : `${help} 2>&1 | cat`;
  const result = spawnShellSync(probe, { encoding: 'utf8', timeout: 15_000 });
  return parseModelsFromHelp(result.stdout ?? '');
}

export function cliCheck(): CliStatus[] {
  // Re-read PATH from the registry first, so installing a tool (or fixing
  // PATH) and pressing Re-check works without restarting mvpfy. Two reg
  // queries are nothing next to the probes below. The macOS equivalent shells
  // out to an interactive login shell, which is far too slow to repeat here,
  // and is not needed: a new PATH there arrives with the next app launch.
  if (IS_WIN) resolveWindowsPath();
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
