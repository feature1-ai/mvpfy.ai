import { CliName, CliStatus } from '../../shared/types';

export interface CliHelp {
  label: string;
  installHint: string;
  installUrl: string;
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
  },
  docker: {
    label: 'Docker',
    installHint: 'brew install --cask docker',
    installUrl: 'https://docs.docker.com/desktop/install/mac-install/',
  },
  claude: {
    label: 'Claude Code',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    label: 'Codex CLI',
    installHint: 'npm install -g @openai/codex',
    installUrl: 'https://github.com/openai/codex',
  },
};

export async function checkClis(): Promise<CliStatus[]> {
  return window.mvpfy.cliCheck();
}

export function allClisPresent(statuses: CliStatus[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s.found);
}
