import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentKind, CliName, CliStatus, REQUIRED_CLIS } from '../../shared/types';
import { terminalCommand } from './install';
import { IS_WIN, resolveWindowsPath, shellQuote, spawnShellSync } from './shell';

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
  // Being signed in to gh does not give git credentials: this is the step
  // that wires gh in as git's credential helper, and a sign-in done by hand
  // outside mvpfy often skips it.
  'git-auth': { command: 'gh auth setup-git', mode: 'in-app' },
  claude: { command: 'claude auth login', mode: 'terminal' },
};

/** The shell command that signs `tool` in from inside the app. */
export function loginCommand(tool: string): string {
  const entry = LOGIN_COMMANDS[tool];
  if (!entry) throw new Error(`No in-app sign-in for "${tool}"`);
  if (entry.mode === 'terminal') {
    // Windows was told to go and run this itself, because the only terminal
    // wrapper was AppleScript. cmd.exe can host an interactive sign-in just as
    // well; Linux has no one terminal to open, so it still says the command.
    if (process.platform !== 'darwin' && !IS_WIN) {
      throw new Error(`Run "${entry.command}" in a terminal, then re-check`);
    }
    return terminalCommand(entry.command);
  }
  return entry.command;
}

/**
 * Sign in to several tools in one run, one after another.
 *
 * Sequential, never parallel: each of these prints a code or opens a browser
 * and waits for the person to finish. Two at once would interleave two device
 * codes in the same log, and there is no telling which is which.
 *
 * Only the ones that stream in-app. A sign-in that needs its own window has to
 * be started by the person who will answer it, and there is no sense opening
 * three windows at once for them to work through in an order nobody stated.
 *
 * No agent fallback here, unlike installing. Signing in means a browser, a
 * password and a second factor; handing that to an agent would mean handing it
 * credentials, and mvpfy does not ask anyone for those.
 */
export function signInAllCommand(tools: string[]): string {
  const doable = tools.filter((t) => LOGIN_COMMANDS[t]?.mode === 'in-app');
  if (doable.length === 0) {
    throw new Error('These sign-ins each need their own window — start them one at a time');
  }
  // "then, regardless": one refused sign-in must not skip the rest, and the
  // person is sitting there watching either way.
  const andThen = IS_WIN ? ' & ' : ' ; ';
  return doable
    .map((t) => {
      const label = t === 'git-auth' ? 'git credentials' : t;
      return `echo ${shellQuote(`── signing in to ${label}`)} ${andThen} ${LOGIN_COMMANDS[t].command}`;
    })
    .join(andThen);
}

/** Tools needing a sign-in that mvpfy cannot stream — their own window. */
export function signInNeedsOwnWindow(tools: string[]): string[] {
  return tools.filter((t) => LOGIN_COMMANDS[t]?.mode === 'terminal');
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

/**
 * Models named in a Codex config file.
 *
 * Codex has no way to list what an account may use — no `codex models`, and
 * `--model` takes any string, so its help offers nothing to read the way
 * Claude's does. What can be known is what this person actually uses: the
 * model codex is configured with, and any named in a profile or pinned to a
 * project. That is a real list, sourced from their own setup, and it cannot go
 * stale the way a list written here would.
 *
 * `model_provider` and friends are deliberately not matched — only `model`.
 */
export function parseCodexModels(configToml: string): string[] {
  const found = (configToml ?? '')
    .split('\n')
    .map((line) => line.match(/^\s*model\s*=\s*["']([^"']+)["']/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => m[1].trim())
    .filter(Boolean);
  return [...new Set(found)];
}

function codexModels(): string[] {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    return parseCodexModels(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  } catch {
    // No config yet is the normal state of a fresh install, not a failure —
    // the picker falls back to letting the user type a name.
    return [];
  }
}

/** Ask an agent CLI which models it will accept. Empty when it will not say. */
export function agentModels(agent: CliName): string[] {
  // Codex says nothing useful in its help; what it does have is the user's
  // own configuration.
  if (agent === 'codex') return codexModels();
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

/**
 * Register a Feature1 workspace as an MCP server on Claude Code itself.
 *
 * User scope, so one registration serves every project and nothing is written
 * into any repository — project scope would put an .mcp.json in the code and
 * someone would commit it. `remove` first because `add` refuses a name that is
 * already taken, and reconnecting to a different workspace must replace the
 * old one rather than fail; it runs unconditionally, since "not registered" is
 * the state we want either way.
 */
export function mcpAddCommand(name: string, url: string, agent: AgentKind = 'claude'): string {
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Unsupported agent');
  if (agent === 'codex') {
    return `codex mcp add ${shellQuote(name)} --url ${shellQuote(url)}`;
  }
  const alsoRun = IS_WIN ? '&' : ';';
  return (
    `claude mcp remove ${shellQuote(name)} -s user ${alsoRun} ` +
    `claude mcp add --transport http ${shellQuote(name)} ${shellQuote(url)} -s user`
  );
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
