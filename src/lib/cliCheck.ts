import { CliName, CliStatus } from '../../shared/types';

export type HostOs = 'mac' | 'windows' | 'linux';

/** Which OS the app is running on, for install instructions. */
export function hostOs(): HostOs {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  return 'linux';
}

export interface CliHelp {
  label: string;
  /** Install command per OS — a macOS one shown on Windows is just wrong. */
  installHint: Record<HostOs, string>;
  installUrl: string;
  /** Terminal command that signs the CLI in, when it has a login. */
  authFix?: string;
  /** mvpfy can start the sign-in itself. */
  inAppLogin?: boolean;
  /** That sign-in opens Terminal.app rather than streaming in-app. */
  loginInTerminal?: boolean;
  /** This tool has no sign-in of its own — it borrows another's. */
  authVia?: CliName;
  /** Needed only when the matching agent is selected, not always. */
  optionalFor?: 'codex';
}

export const CLI_HELP: Record<CliName, CliHelp> = {
  git: {
    label: 'Git',
    installHint: {
      mac: 'xcode-select --install',
      windows: 'winget install --id Git.Git',
      linux: 'sudo apt install git',
    },
    installUrl: 'https://git-scm.com/downloads',
    // Git has no login of its own: pushes and private clones use the
    // credentials `gh auth login` writes into git's credential helper.
    authVia: 'gh',
  },
  gh: {
    label: 'GitHub CLI',
    installHint: {
      mac: 'brew install gh',
      windows: 'winget install --id GitHub.cli',
      linux: 'sudo apt install gh',
    },
    installUrl: 'https://cli.github.com/',
    authFix: 'gh auth login',
    inAppLogin: true,
  },
  docker: {
    label: 'Docker',
    installHint: {
      mac: 'brew install --cask docker-desktop',
      windows: 'winget install --id Docker.DockerDesktop',
      linux: 'curl -fsSL https://get.docker.com | sh',
    },
    installUrl: 'https://docs.docker.com/desktop/',
  },
  claude: {
    label: 'Claude Code',
    installHint: {
      mac: 'curl -fsSL https://claude.ai/install.sh | bash',
      // npm rather than a PowerShell one-liner: it is the install route we
      // can state with confidence, and it puts claude on PATH via %APPDATA%\npm.
      windows: 'npm install -g @anthropic-ai/claude-code',
      linux: 'curl -fsSL https://claude.ai/install.sh | bash',
    },
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    authFix: 'claude auth login',
    inAppLogin: true,
    loginInTerminal: true,
  },
  codex: {
    label: 'Codex CLI',
    installHint: {
      mac: 'npm install -g @openai/codex',
      windows: 'npm install -g @openai/codex',
      linux: 'npm install -g @openai/codex',
    },
    installUrl: 'https://github.com/openai/codex',
    authFix: 'codex login',
    inAppLogin: true,
    optionalFor: 'codex',
  },
};

export async function checkClis(): Promise<CliStatus[]> {
  return window.mvpfy.cliCheck();
}

/** The install command to show for this tool on the OS we are running on. */
export function installHintFor(name: CliName, os: HostOs = hostOs()): string {
  return CLI_HELP[name].installHint[os];
}

export function allClisPresent(statuses: CliStatus[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s.found);
}

/**
 * Verify the tools a run depends on are installed AND signed in before
 * spawning it, so the PM gets one clear message instead of a cryptic
 * mid-run agent failure. Returns null when everything is ready.
 */
/** True when this CLI matters given the selected default agent. */
export function cliRequired(name: CliName, defaultAgent: 'claude' | 'codex'): boolean {
  const optionalFor = CLI_HELP[name].optionalFor;
  return optionalFor === undefined || optionalFor === defaultAgent;
}

export async function preflightAuth(
  agent: 'claude' | 'codex',
  needGh: boolean
): Promise<string | null> {
  const statuses = await checkClis();
  const problems: string[] = [];
  const check = (name: CliName) => {
    const s = statuses.find((x) => x.name === name);
    const help = CLI_HELP[name];
    if (!s?.found) {
      problems.push(`${help.label} was not found (install: ${installHintFor(name)})`);
    } else if (s.authenticated === false && help.authFix) {
      problems.push(
        `${help.label} is not signed in — run "${help.authFix}" in Terminal, then retry`
      );
    }
  };
  check(agent);
  if (needGh) check('gh');
  return problems.length > 0 ? problems.join('. ') : null;
}
