import { useState } from 'react';
import { AgentKind, CliStatus, MvpfyState } from '../../shared/types';
import { UpdateState } from '../hooks/useProjectController';
import { CLI_HELP } from '../lib/cliCheck';
import { Feature1McpClient, mcpHost, tokenKeychainEntry } from '../lib/feature1Mcp';

interface Props {
  state: MvpfyState;
  cliStatuses: CliStatus[];
  onRefreshClis: () => void;
  updateState: UpdateState;
}

export default function SettingsView({ state, cliStatuses, onRefreshClis, updateState }: Props) {
  const [slugInput, setSlugInput] = useState(state.tenant?.slug ?? '');
  const [loginStatus, setLoginStatus] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [loginError, setLoginError] = useState<string | null>(null);

  async function connectFeature1() {
    const slug = slugInput.trim().toLowerCase();
    if (!slug) return;
    setLoginStatus('waiting');
    setLoginError(null);
    try {
      const client = new Feature1McpClient(slug, null);
      const { loginUrl, loginId } = await client.browserLogin();
      await window.mvpfy.openExternal(loginUrl);
      const token = await client.pollLoginStatus(loginId);
      const entry = tokenKeychainEntry(slug);
      await window.mvpfy.keychainSet(entry, token);
      updateState((prev) => ({
        ...prev,
        tenant: { slug, host: mcpHost(slug), tokenKeychainEntry: entry },
      }));
      setLoginStatus('idle');
    } catch (err) {
      setLoginStatus('error');
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  }

  const gh = cliStatuses.find((s) => s.name === 'gh');

  return (
    <div className="mx-auto w-full max-w-[660px] px-6 pb-16 pt-9">
      <h1 className="mb-7 text-[22px] font-semibold tracking-[-0.02em]">Settings</h1>

      <div className="section-label mb-3">Connections</div>
      <section className="card mb-7 grid gap-4 px-[18px] py-4">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">Feature1</p>
            <p className="text-[12.5px] text-muted">Pull stories, push pull requests.</p>
          </div>
          {state.tenant ? (
            <span className="flex items-center gap-1.5 text-xs text-go">
              <span className="h-1.5 w-1.5 rounded-full bg-go" />
              {state.tenant.host}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <input
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value)}
                placeholder="tenant slug"
                className="h-[30px] w-32 rounded-md border border-line px-2.5 text-[12.5px] outline-none focus:border-muted"
              />
              <button
                onClick={() => void connectFeature1()}
                disabled={loginStatus === 'waiting' || !slugInput.trim()}
                className="btn-primary h-[30px] px-3 text-[12.5px] disabled:opacity-50"
              >
                {loginStatus === 'waiting' ? 'Waiting…' : 'Connect'}
              </button>
            </div>
          )}
        </div>
        {loginStatus === 'error' && loginError && (
          <p className="text-[12.5px] text-danger">{loginError}</p>
        )}
        <div className="border-t border-line-subtle" />
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">GitHub</p>
            <p className="text-[12.5px] text-muted">
              Clone private repositories, open pull requests.
            </p>
          </div>
          {gh?.authenticated ? (
            <span className="flex items-center gap-1.5 text-xs text-go">
              <span className="h-1.5 w-1.5 rounded-full bg-go" />
              connected
            </span>
          ) : (
            <span className="text-xs text-muted">
              run <code className="rounded bg-paper px-1 font-mono">gh auth login</code> in Terminal
            </span>
          )}
        </div>
      </section>

      <div className="section-label mb-3">Agent</div>
      <section className="card mb-7 grid gap-4 px-[18px] py-4">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">Default agent</p>
            <p className="text-[12.5px] text-muted">Which CLI implements stories and bootstraps.</p>
          </div>
          <select
            value={state.settings.defaultAgent}
            onChange={(e) =>
              updateState((prev) => ({
                ...prev,
                settings: { ...prev.settings, defaultAgent: e.target.value as AgentKind },
              }))
            }
            className="h-[34px] rounded-md border border-line bg-surface px-2.5 text-[13px]"
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex CLI</option>
          </select>
        </div>
        <div className="border-t border-line-subtle" />
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">Codex model</p>
            <p className="text-[12.5px] text-muted">Used only when the default agent is Codex.</p>
          </div>
          <input
            value={state.settings.codexModel}
            onChange={(e) =>
              updateState((prev) => ({
                ...prev,
                settings: { ...prev.settings, codexModel: e.target.value },
              }))
            }
            className="h-[34px] w-44 rounded-md border border-line px-[11px] font-mono text-[12.5px] outline-none focus:border-muted"
          />
        </div>
      </section>

      <div className="mb-3 flex items-center justify-between">
        <span className="section-label">Required tools</span>
        <button
          onClick={onRefreshClis}
          className="text-xs text-go hover:text-go-hover hover:underline"
        >
          Re-check
        </button>
      </div>
      <section className="card mb-7 grid gap-3 px-[18px] py-4">
        {cliStatuses.map((cli) => {
          const help = CLI_HELP[cli.name];
          const needsLogin = cli.found && cli.authenticated === false;
          return (
            <div key={cli.name} className="flex items-center gap-3">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  !cli.found ? 'bg-danger' : needsLogin ? 'bg-warn-text' : 'bg-go'
                }`}
              />
              <span className="w-24 text-[13px] font-medium">{help.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
                {cli.found ? cli.path : help.installHint}
              </span>
              {needsLogin && help.authFix && (
                <span className="text-[11.5px] text-warn-text">
                  run <code className="font-mono">{help.authFix}</code>
                </span>
              )}
              {!cli.found && (
                <button
                  onClick={() => void window.mvpfy.openExternal(help.installUrl)}
                  className="text-[11.5px] text-go hover:underline"
                >
                  Install ↗
                </button>
              )}
            </div>
          );
        })}
        {cliStatuses.length === 0 && <p className="text-[13px] text-muted">Checking…</p>}
      </section>

      <div className="section-label mb-3">Workspace</div>
      <section className="card grid gap-2 px-[18px] py-4">
        <p className="text-[13.5px] font-medium">Projects folder</p>
        <div className="flex h-[34px] items-center rounded-md border border-line bg-sunken px-[11px] font-mono text-[12.5px] text-body">
          ~/.mvpfy/projects
        </div>
        <p className="text-xs text-muted">
          Each project takes the next free port when it is bootstrapped.
        </p>
      </section>
    </div>
  );
}
