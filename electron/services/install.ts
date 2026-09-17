import { InstallPlan } from '../../shared/types';
import { IS_WIN, shellQuote, spawnShellSync } from './shell';

/**
 * Installing the required tools from inside mvpfy — Homebrew on macOS, winget
 * on Windows.
 *
 * Two execution modes, and the split matters:
 *
 *   'in-app'   — the command needs no password and no terminal, so mvpfy runs
 *                it and streams the output into Settings.
 *   'terminal' — the command needs the user's password, or admin rights, or
 *                puts up its own installer window. mvpfy hands those to a real
 *                terminal rather than pretending it can answer a prompt from a
 *                pipe — a password dialog nobody can see looks exactly like an
 *                install that hung.
 *
 * Every command is the tool's own official install line, shown to the user
 * before it runs. mvpfy never invents a mirror or a shortcut.
 */

const IS_MAC = process.platform === 'darwin';

function has(binary: string): boolean {
  const locator = IS_WIN ? `where ${binary}` : `command -v ${binary}`;
  const res = spawnShellSync(locator, { encoding: 'utf8', timeout: 10_000 });
  return res.status === 0 && res.stdout.trim().length > 0;
}

/**
 * Windows installs through winget, which ships with Windows 10 and 11 and is
 * Microsoft's own package manager — the same standing Homebrew has on a Mac.
 *
 * Every line is the vendor's documented winget id. `--accept-*-agreements` is
 * not a shortcut past anything the user should read: winget refuses to run
 * unattended without them, and the alternative is an install that appears to
 * hang while waiting for a prompt nobody can see.
 */
function windowsPlans(): InstallPlan[] {
  const winget = has('winget');
  const npm = has('npm');
  const viaWinget = (
    tool: string,
    label: string,
    id: string,
    note: string,
    mode: InstallPlan['mode'] = 'in-app'
  ): InstallPlan => ({
    tool,
    label,
    command: `winget install --id ${id} -e --source winget --accept-package-agreements --accept-source-agreements`,
    mode,
    note: winget ? note : 'needs winget — update to Windows 10 1809 or later',
    available: winget,
  });

  return [
    viaWinget('git', 'Git', 'Git.Git', 'Installs with winget.'),
    viaWinget('gh', 'GitHub CLI', 'GitHub.cli', 'Installs with winget.'),
    // Docker Desktop puts up its own installer and asks for admin rights.
    viaWinget(
      'docker',
      'Docker Desktop',
      'Docker.DockerDesktop',
      'Opens its own installer and asks for admin rights.',
      'terminal'
    ),
    {
      tool: 'claude',
      label: 'Claude Code',
      command: 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"',
      mode: 'in-app',
      note: "Anthropic's own installer. No package manager needed.",
      available: true,
    },
    npm
      ? {
          tool: 'codex',
          label: 'Codex CLI',
          command: 'npm install -g @openai/codex',
          mode: 'in-app',
          note: 'Installs with npm. No admin rights needed.',
          available: true,
        }
      : {
          ...viaWinget(
            'codex',
            'Codex CLI',
            'OpenJS.NodeJS.LTS',
            'Installs Node first, then Codex.'
          ),
          command:
            'winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements & npm install -g @openai/codex',
        },
  ];
}

/** Hand a command to a terminal window, where it can prompt for a password. */
export function terminalCommand(command: string): string {
  // /k keeps the window open once the installer finishes, so an error stays
  // readable instead of the window closing on whatever it had to say.
  if (IS_WIN) return `start "" cmd /k ${command}`;
  // The command is embedded in an AppleScript string literal, which is then a
  // shell argument: escape for AppleScript first, then quote for the shell.
  const applescript = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return (
    `osascript -e 'tell application "Terminal" to activate' ` +
    `-e ${shellQuote(`tell application "Terminal" to do script "${applescript}"`)}`
  );
}

const BREW_INSTALL =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/**
 * What installing each tool would actually do on this machine. Recomputed on
 * demand because installing Homebrew changes the answer for several others.
 */
export function installPlans(): InstallPlan[] {
  if (IS_WIN) return windowsPlans();
  if (!IS_MAC) return [];
  const brew = has('brew');
  const npm = has('npm');

  const viaBrew = (tool: string, label: string, formula: string): InstallPlan =>
    brew
      ? {
          tool,
          label,
          command: `brew install ${formula}`,
          mode: 'in-app',
          note: 'Installs with Homebrew. No password needed.',
          available: true,
        }
      : {
          tool,
          label,
          command: `brew install ${formula}`,
          mode: 'in-app',
          note: 'needs Homebrew',
          available: false,
        };

  return [
    {
      tool: 'brew',
      label: 'Homebrew',
      command: BREW_INSTALL,
      mode: 'terminal',
      note: 'Opens Terminal — Homebrew asks for your Mac password. Come back when it finishes.',
      available: !brew,
    },
    {
      tool: 'git',
      label: 'Git',
      command: 'xcode-select --install',
      mode: 'terminal',
      note: "Opens Apple's own installer window for the command line tools.",
      available: true,
    },
    viaBrew('gh', 'GitHub CLI', 'gh'),
    viaBrew('docker', 'Docker Desktop', '--cask docker-desktop'),
    {
      tool: 'claude',
      label: 'Claude Code',
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
      mode: 'in-app',
      note: "Anthropic's own installer. No Homebrew, no Node, no password.",
      available: true,
    },
    npm
      ? {
          tool: 'codex',
          label: 'Codex CLI',
          command: 'npm install -g @openai/codex',
          mode: 'in-app',
          note: 'Installs with npm. No password needed.',
          available: true,
        }
      : {
          tool: 'codex',
          label: 'Codex CLI',
          command: 'brew install node && npm install -g @openai/codex',
          mode: 'in-app',
          note: brew
            ? 'Installs Node first, then Codex.'
            : 'needs Node — install Homebrew first, or install Node yourself',
          available: brew,
        },
  ];
}

/** The shell command that installs `tool`, ready to spawn. */
export function installCommand(tool: string): string {
  const plan = installPlans().find((p) => p.tool === tool);
  if (!plan) {
    throw new Error(
      IS_MAC || IS_WIN
        ? `No installer for "${tool}"`
        : 'In-app install is macOS and Windows only for now'
    );
  }
  if (!plan.available) throw new Error(`${plan.label} cannot be installed yet: ${plan.note}`);
  return plan.mode === 'terminal' ? terminalCommand(plan.command) : plan.command;
}

/**
 * Install everything missing that can be installed without a password, in one
 * run.
 *
 * Joined so that one failure does not cancel the rest: a machine missing four
 * tools should end up missing at most the one that actually could not be
 * installed, and the log should say which. Chaining on success instead would
 * make the first failure look like four.
 *
 * Tools whose installer needs a password or admin rights are left out — they
 * each need their own window, and running them in a pipe hangs on a prompt the
 * user cannot see. The caller offers those separately.
 */
export function installAllCommand(tools: string[]): string {
  const plans = installPlans();
  const doable = tools
    .map((t) => plans.find((p) => p.tool === t))
    .filter((p): p is InstallPlan => Boolean(p?.available && p.mode === 'in-app'));
  if (doable.length === 0) {
    throw new Error('Nothing here can be installed without a password — install those first');
  }
  // `;` on a POSIX shell and `&` on cmd.exe both mean "then, regardless".
  const andThen = IS_WIN ? ' & ' : ' ; ';
  return doable
    .map((p) => `echo ${shellQuote(`── installing ${p.label}`)} ${andThen} ${p.command}`)
    .join(andThen);
}

/** Tools that are missing and installable, but need their own window. */
export function needsOwnWindow(tools: string[]): InstallPlan[] {
  const plans = installPlans();
  return tools
    .map((t) => plans.find((p) => p.tool === t))
    .filter((p): p is InstallPlan => Boolean(p?.available && p.mode === 'terminal'));
}
