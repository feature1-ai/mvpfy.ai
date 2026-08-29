import { InstallPlan } from '../../shared/types';
import { shellQuote, spawnShellSync } from './shell';

/**
 * Installing the required tools from inside mvpfy — macOS only for now.
 *
 * Two execution modes, and the split matters:
 *
 *   'in-app'   — the command needs no password and no terminal, so mvpfy runs
 *                it and streams the output into Settings.
 *   'terminal' — the command needs the user's password (Homebrew) or puts up
 *                its own installer window (Apple's command line tools). mvpfy
 *                hands those to Terminal.app rather than pretending it can
 *                answer a sudo prompt from a pipe.
 *
 * Every command is the tool's own official install line, shown to the user
 * before it runs. mvpfy never invents a mirror or a shortcut.
 */

const IS_MAC = process.platform === 'darwin';

function has(binary: string): boolean {
  const res = spawnShellSync(`command -v ${binary}`, { encoding: 'utf8', timeout: 10_000 });
  return res.status === 0 && res.stdout.trim().length > 0;
}

/** Hand a command to Terminal.app, where it can prompt for a password. */
export function terminalCommand(command: string): string {
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
    throw new Error(IS_MAC ? `No installer for "${tool}"` : 'In-app install is macOS-only for now');
  }
  if (!plan.available) throw new Error(`${plan.label} cannot be installed yet: ${plan.note}`);
  return plan.mode === 'terminal' ? terminalCommand(plan.command) : plan.command;
}
