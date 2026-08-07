import { Settings } from 'mvpfy';

const state = {
  tenant: { slug: 'acme', host: 'acme-mcp.feature1.ai', tokenKeychainEntry: 'feature1-mcp-acme' },
  settings: { defaultAgent: 'claude' as const, codexModel: 'gpt-5.3-codex' },
  projects: [],
};

const allGood = [
  { name: 'git' as const, found: true, path: '/usr/bin/git', authenticated: null },
  { name: 'gh' as const, found: true, path: '/opt/homebrew/bin/gh', authenticated: true },
  { name: 'docker' as const, found: true, path: '/usr/local/bin/docker', authenticated: null },
  { name: 'claude' as const, found: true, path: '/Users/pm/.local/bin/claude', authenticated: true },
  { name: 'codex' as const, found: true, path: '/opt/homebrew/bin/codex', authenticated: true },
];

const needsAttention = [
  { name: 'git' as const, found: true, path: '/usr/bin/git', authenticated: null },
  { name: 'gh' as const, found: true, path: '/opt/homebrew/bin/gh', authenticated: false },
  { name: 'docker' as const, found: false, path: null, authenticated: null },
  { name: 'claude' as const, found: true, path: '/Users/pm/.local/bin/claude', authenticated: true },
  { name: 'codex' as const, found: true, path: '/opt/homebrew/bin/codex', authenticated: false },
];

export const AllReady = () => (
  <Settings
    state={state as never}
    cliStatuses={allGood as never}
    onRefreshClis={() => {}}
    updateState={() => {}}
  />
);

export const NeedsAttention = () => (
  <Settings
    state={{ ...state, tenant: null } as never}
    cliStatuses={needsAttention as never}
    onRefreshClis={() => {}}
    updateState={() => {}}
  />
);
