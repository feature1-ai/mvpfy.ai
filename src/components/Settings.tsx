import { useState } from 'react';
import { AgentKind, CliStatus, MvpfyState } from '../../shared/types';
import { CLI_HELP } from '../lib/cliCheck';
import { Feature1McpClient, mcpHost, tokenKeychainEntry } from '../lib/feature1Mcp';

interface Props {
  state: MvpfyState;
  cliStatuses: CliStatus[];
  onRefreshClis: () => void;
  updateState: (mutate: (prev: MvpfyState) => MvpfyState) => void;
}

export default function Settings({ state, cliStatuses, onRefreshClis, updateState }: Props) {
  const [slugInput, setSlugInput] = useState(state.tenant?.slug ?? '');
  const [loginStatus, setLoginStatus] = useState<'idle' | 'waiting' | 'done' | 'error'>(
    state.tenant ? 'done' : 'idle'
  );
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
      setLoginStatus('done');
    } catch (err) {
      setLoginStatus('error');
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="mb-5 text-lg font-bold">Settings</h2>

      <section className="mb-6 max-w-xl rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Feature1 cloud
        </h3>
        <label className="mb-1 block text-sm font-medium">Tenant slug</label>
        <div className="flex gap-2">
          <input
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value)}
            placeholder="acme"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
          <button
            onClick={() => void connectFeature1()}
            disabled={loginStatus === 'waiting' || !slugInput.trim()}
            className="rounded-md bg-brand-dark px-4 py-2 text-sm font-medium text-white hover:bg-brand disabled:opacity-50"
          >
            {loginStatus === 'waiting' ? 'Waiting for browser…' : 'Sign in'}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          MCP endpoint: {slugInput.trim() ? `https://${mcpHost(slugInput.trim())}/mcp/` : '—'}
        </p>
        {loginStatus === 'done' && state.tenant && (
          <p className="mt-2 text-sm text-emerald-600">
            Connected to {state.tenant.host}. Token stored in the system keychain.
          </p>
        )}
        {loginStatus === 'error' && loginError && (
          <p className="mt-2 text-sm text-red-600">{loginError}</p>
        )}
      </section>

      <section className="mb-6 max-w-xl rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Agent
        </h3>
        <label className="mb-1 block text-sm font-medium">Default agent</label>
        <select
          value={state.settings.defaultAgent}
          onChange={(e) =>
            updateState((prev) => ({
              ...prev,
              settings: { ...prev.settings, defaultAgent: e.target.value as AgentKind },
            }))
          }
          className="mb-4 w-48 rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex CLI</option>
        </select>

        <label className="mb-1 block text-sm font-medium">Codex model</label>
        <input
          value={state.settings.codexModel}
          onChange={(e) =>
            updateState((prev) => ({
              ...prev,
              settings: { ...prev.settings, codexModel: e.target.value },
            }))
          }
          placeholder="gpt-5.3-codex"
          className="w-64 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-slate-500">Used only when the default agent is Codex.</p>
      </section>

      <section className="max-w-xl rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Required CLIs
          </h3>
          <button onClick={onRefreshClis} className="text-xs font-medium text-brand hover:underline">
            Re-check
          </button>
        </div>
        <ul className="divide-y divide-slate-100">
          {cliStatuses.map((cli) => {
            const help = CLI_HELP[cli.name];
            const needsLogin = cli.found && cli.authenticated === false;
            return (
              <li key={cli.name} className="flex items-center gap-3 py-2">
                <span
                  className={`text-lg ${
                    !cli.found ? 'text-red-500' : needsLogin ? 'text-amber-500' : 'text-emerald-500'
                  }`}
                >
                  {!cli.found ? '✗' : needsLogin ? '⚠' : '✓'}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{help.label}</span>
                  {cli.found && cli.authenticated === true && (
                    <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">
                      signed in
                    </span>
                  )}
                  <span className="ml-2 font-mono text-xs text-slate-400">
                    {cli.found ? cli.path : help.installHint}
                  </span>
                  {needsLogin && (
                    <p className="mt-0.5 text-xs text-amber-700">
                      Installed but not signed in — run{' '}
                      <code className="rounded bg-amber-50 px-1 font-mono">{help.authFix}</code> in
                      Terminal, then re-check.
                    </p>
                  )}
                </div>
                {needsLogin && help.authFix && (
                  <button
                    onClick={() => void navigator.clipboard.writeText(help.authFix!)}
                    className="text-xs font-medium text-brand hover:underline"
                    title="Copy command"
                  >
                    Copy command
                  </button>
                )}
                {!cli.found && (
                  <button
                    onClick={() => void window.mvpfy.openExternal(help.installUrl)}
                    className="text-xs font-medium text-brand hover:underline"
                  >
                    Install guide ↗
                  </button>
                )}
              </li>
            );
          })}
          {cliStatuses.length === 0 && (
            <li className="py-2 text-sm text-slate-400">Checking…</li>
          )}
        </ul>
      </section>
    </div>
  );
}
