import { CliName, CliStatus } from '../../shared/types';

export interface CliHelp {
  label: string;
  installHint: string;
  installUrl: string;
  /** Terminal command that signs the CLI in, when it has a login. */
  authFix?: string;
  /** In-app sign-in is available (login flow survives without a TTY). */
  inAppLogin?: boolean;
  /** Needed only when the matching agent is selected, not always. */
  optionalFor?: 'codex';
}

export const CLI_HELP: Record<CliName, CliHelp> = {
  git: {
    label: 'Git',
    installHint: 'xcode-select --install',
    installUrl: 'https://git-scm.com/downloads',
  },
  gh: {
    label: 'GitHub CLI',
    installHint: 'brew install gh',
    installUrl: 'https://cli.github.com/',
    authFix: 'gh auth login',
    inAppLogin: true,
  },
  docker: {
    label: 'Docker',
    installHint: 'brew install --cask docker-desktop',
    installUrl: 'https://docs.docker.com/desktop/install/mac-install/',
  },
  claude: {
    label: 'Claude Code',
    installHint: 'curl -fsSL https://claude.ai/install.sh | bash',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    authFix: 'claude',
  },
  codex: {
    label: 'Codex CLI',
    installHint: 'npm install -g @openai/codex',
    installUrl: 'https://github.com/openai/codex',
    authFix: 'codex login',
    inAppLogin: true,
    optionalFor: 'codex',
  },
};

export async function checkClis(): Promise<CliStatus[]> {
  return window.mvpfy.cliCheck();
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
      problems.push(`${help.label} is not installed (install: ${help.installHint})`);
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
