import { useEffect, useState } from 'react';
import {
  AgentKind,
  CliName,
  CliStatus,
  DEFAULT_STACK,
  InstallPlan,
  MvpfyState,
  RELEASES_URL,
  macInstallerUrl,
  UpdateStatus,
} from '../../shared/types';
import { UpdateState } from '../hooks/useProjectController';
import { CLI_HELP, cliRequired, installHintFor } from '../lib/cliCheck';
import { useFeature1Login } from '../hooks/useFeature1Login';
import { startInstallToolsRun } from '../lib/agentRunner';

interface Props {
  version: string;
  state: MvpfyState;
  cliStatuses: CliStatus[];
  onRefreshClis: () => void;
  updateState: UpdateState;
}

let runSeq = 0;
function nextRunId(kind: string, tool: string): string {
  return `cli-${kind}-${tool}-${++runSeq}`;
}

export default function SettingsView({
  version,
  state,
  cliStatuses,
  onRefreshClis,
  updateState,
}: Props) {
  const login = useFeature1Login(state, updateState);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);

  // An update that finishes downloading while Settings is open should change
  // the button under the user, not wait for them to ask again. Only progress
  // is taken from the launch check — its failures are nobody's question yet,
  // and an offline start would otherwise greet them with an error they never
  // asked for.
  useEffect(
    () =>
      window.mvpfy.onUpdateStatus((status) => {
        if (status.kind === 'available' || status.kind === 'downloaded') setUpdate(status);
      }),
    []
  );

  const updateLine = checking
    ? 'Checking for a newer version…'
    : update?.kind === 'downloaded'
      ? `Version ${update.version ?? ''} is downloaded — it installs when you quit mvpfy.`
      : update?.kind === 'available'
        ? `Version ${update.version ?? ''} is available.`
        : update?.kind === 'none'
          ? 'This is the newest version.'
          : update?.kind === 'unsupported'
            ? 'Development builds do not update themselves.'
            : update?.kind === 'error'
              ? `Could not check for updates — ${update.message ?? 'the update server did not answer'}.`
              : 'mvpfy updates itself; this is the build you are running now.';

  const gh = cliStatuses.find((s) => s.name === 'gh');
  const [toolRun, setToolRun] = useState<{
    kind: 'login' | 'install';
    tool: string;
    runId: string;
  } | null>(null);
  const [toolLog, setToolLog] = useState('');
  // The finished run's output, kept after the run clears so the agent can be
  // handed what actually failed rather than being asked to guess.
  const [lastInstallLog, setLastInstallLog] = useState('');
  const [plans, setPlans] = useState<InstallPlan[]>([]);
  const planFor = (tool: string) => plans.find((p) => p.tool === tool) ?? null;
  const brewPlan = planFor('brew');

  // Installing one tool changes what the others need (Homebrew unlocks gh,
  // Docker and Node), so the plans are recomputed whenever the checklist is.
  useEffect(() => {
    void window.mvpfy.installPlans().then(setPlans);
  }, [cliStatuses]);

  // The models come from the installed CLIs, so they are re-read whenever the
  // checklist is — installing or updating an agent can change the list.
  const [models, setModels] = useState<Record<AgentKind, string[]>>({ claude: [], codex: [] });
  useEffect(() => {
    void Promise.all([window.mvpfy.agentModels('claude'), window.mvpfy.agentModels('codex')]).then(
      ([claude, codex]) => setModels({ claude, codex })
    );
  }, [cliStatuses]);

  // Stream sign-in and install output: device codes, URLs and progress bars
  // all matter to the person watching.
  useEffect(() => {
    if (!toolRun) return;
    const offOut = window.mvpfy.onRunOutput((ev) => {
      if (ev.runId === toolRun.runId) setToolLog((prev) => (prev + ev.chunk).slice(-4000));
    });
    const offExit = window.mvpfy.onRunExit((ev) => {
      if (ev.runId === toolRun.runId) {
        if (toolRun.kind === 'install') setLastInstallLog(toolLog);
        setToolRun(null);
        setToolLog('');
        onRefreshClis();
      }
    });
    return () => {
      offOut();
      offExit();
    };
  }, [toolRun, toolLog, onRefreshClis]);

  function signIn(tool: string) {
    const runId = nextRunId('login', tool);
    setToolLog('');
    setToolRun({ kind: 'login', tool, runId });
    void window.mvpfy.cliLogin(runId, tool).catch(() => setToolRun(null));
  }

  function install(tool: string) {
    const runId = nextRunId('install', tool);
    setToolLog('');
    setToolRun({ kind: 'install', tool, runId });
    void window.mvpfy.installTool(runId, tool).catch(() => setToolRun(null));
  }

  // Everything missing that installs without a password, in one run. The ones
  // that need their own window are listed underneath instead: each has to be
  // started by the person who can type the password.
  const missingTools = cliStatuses
    .filter((c) => !c.found && cliRequired(c.name, state.settings.defaultAgent))
    .map((c) => c.name as string);
  const installableNow = missingTools.filter(
    (t) => planFor(t)?.available && planFor(t)?.mode === 'in-app'
  );
  const needOwnWindow = missingTools.filter(
    (t) => planFor(t)?.available && planFor(t)?.mode === 'terminal'
  );
  // Asking the agent to install the agent is not an answer, so this is only
  // offered once one of them is actually on the machine.
  const agentPresent = cliStatuses.some(
    (c) => (c.name === 'claude' || c.name === 'codex') && c.found
  );

  // Installed but not signed in is the other half of not working: gh without
  // a sign-in fails at the push, mid-run, having looked fine in the checklist.
  const needsSignIn = cliStatuses
    .filter(
      (c) =>
        c.found &&
        c.authenticated === false &&
        CLI_HELP[c.name].inAppLogin &&
        cliRequired(c.name, state.settings.defaultAgent)
    )
    .map((c) => c.name as string);
  // A sign-in that opens its own window has to be started by the person who
  // will answer it — three windows at once, in no stated order, is worse.
  const signInStreams = needsSignIn.filter((t) => !CLI_HELP[t as CliName].loginInTerminal);

  function signInAll() {
    if (signInStreams.length === 0) return;
    const runId = nextRunId('login', 'all');
    setToolLog('');
    setToolRun({ kind: 'login', tool: 'all', runId });
    void window.mvpfy.signInAll(runId, signInStreams).catch(() => setToolRun(null));
  }

  function installAll() {
    if (installableNow.length === 0) return;
    const runId = nextRunId('install', 'all');
    setLastInstallLog('');
    setToolLog('');
    setToolRun({ kind: 'install', tool: 'all', runId });
    void window.mvpfy.installAll(runId, installableNow).catch(() => setToolRun(null));
  }

  function askAgentToInstall() {
    if (missingTools.length === 0 || !agentPresent) return;
    setToolLog('');
    void startInstallToolsRun(state.settings, missingTools, lastInstallLog)
      .then((handle) => setToolRun({ kind: 'install', tool: 'agent', runId: handle.runId }))
      .catch(() => setToolRun(null));
  }

  return (
    <div className="mx-auto w-full max-w-[660px] px-6 pb-16 pt-9">
      <h1 className="mb-7 text-[22px] font-semibold tracking-[-0.02em]">Settings</h1>

      <div className="mb-3 flex items-center justify-between">
        <span className="section-label">Required tools</span>
        <div className="flex items-center gap-3">
          {installableNow.length === 0 && signInStreams.length > 1 && (
            <button
              onClick={signInAll}
              disabled={toolRun !== null}
              title={'Signs in to each in turn — finish one and the next starts'}
              className="btn-primary h-6 px-2.5 text-[11.5px] disabled:opacity-50"
            >
              {toolRun?.tool === 'all' ? 'Signing in…' : `Sign in to all (${signInStreams.length})`}
            </button>
          )}
          {installableNow.length > 0 && (
            <button
              onClick={installAll}
              disabled={toolRun !== null}
              title={installableNow.map((t) => planFor(t)?.command).join('\n')}
              className="btn-primary h-6 px-2.5 text-[11.5px] disabled:opacity-50"
            >
              {toolRun?.tool === 'all' ? 'Installing…' : `Install all (${installableNow.length})`}
            </button>
          )}
          <button
            onClick={onRefreshClis}
            className="text-xs text-go hover:text-go-hover hover:underline"
          >
            Re-check
          </button>
        </div>
      </div>
      <section className="card mb-7 flex flex-col gap-3 px-[18px] py-4">
        {cliStatuses.map((cli) => {
          const help = CLI_HELP[cli.name];
          const required = cliRequired(cli.name, state.settings.defaultAgent);
          const needsLogin = cli.found && cli.authenticated === false;
          const busy = toolRun?.tool === cli.name;
          const plan = planFor(cli.name);
          return (
            <div key={cli.name} className="flex items-center gap-3">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  !cli.found
                    ? required
                      ? 'bg-danger'
                      : 'bg-dot-idle'
                    : needsLogin
                      ? required
                        ? 'bg-warn-text'
                        : 'bg-dot-idle'
                      : 'bg-go'
                }`}
              />
              <span className="w-24 text-[13px] font-medium">
                {help.label}
                {!required && <span className="ml-1 text-[10px] text-faint">optional</span>}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
                {cli.found ? cli.path : installHintFor(cli.name)}
              </span>
              {cli.found &&
                help.authVia &&
                !cliStatuses.find((s) => s.name === help.authVia)?.authenticated && (
                  <span className="shrink-0 text-[11.5px] text-warn-text">
                    needs the {CLI_HELP[help.authVia].label} sign-in to push
                  </span>
                )}
              {needsLogin && help.inAppLogin && (
                <button
                  onClick={() => signIn(cli.name)}
                  disabled={toolRun !== null}
                  className="btn-primary h-6 px-2.5 text-[11.5px] disabled:opacity-50"
                >
                  {busy ? 'Waiting…' : help.loginInTerminal ? 'Sign in…' : 'Sign in'}
                </button>
              )}
              {needsLogin && !help.inAppLogin && help.authFix && (
                <span className="text-[11.5px] text-warn-text">
                  run <code className="font-mono">{help.authFix}</code> in Terminal
                </span>
              )}
              {!cli.found && plan?.available && (
                <button
                  onClick={() => install(cli.name)}
                  disabled={toolRun !== null}
                  title={`${plan.command}\n\n${plan.note}`}
                  className="btn-primary h-6 shrink-0 px-2.5 text-[11.5px] disabled:opacity-50"
                >
                  {busy ? 'Installing…' : plan.mode === 'terminal' ? 'Install…' : 'Install'}
                </button>
              )}
              {!cli.found && !plan?.available && (
                <>
                  {plan && (
                    <span className="shrink-0 text-[11.5px] text-warn-text">{plan.note}</span>
                  )}
                  <button
                    onClick={() => void window.mvpfy.openExternal(help.installUrl)}
                    className="shrink-0 text-[11.5px] text-go hover:underline"
                  >
                    Install ↗
                  </button>
                </>
              )}
            </div>
          );
        })}
        {/* What Install all could not do, and what can still be done about it.
            Only after an attempt: offering to rescue an install nobody has
            tried yet is noise. */}
        {!toolRun && missingTools.length > 0 && lastInstallLog !== '' && (
          <div className="flex flex-col gap-2 rounded-lg border border-warn-border bg-warn-bg px-3.5 py-3">
            <span className="text-[12.5px] text-warn-text">
              Still missing after that: <strong>{missingTools.join(', ')}</strong>.
            </span>
            {needOwnWindow.length > 0 && (
              <span className="text-[11.5px] text-warn-text">
                {needOwnWindow.map((t) => planFor(t)?.label).join(' and ')} must be installed from
                its own window — it asks for a password mvpfy cannot answer.
              </span>
            )}
            {agentPresent ? (
              <div className="flex items-center gap-2.5">
                <button
                  onClick={askAgentToInstall}
                  className="btn-primary h-6 px-2.5 text-[11.5px]"
                >
                  Let the agent sort it out
                </button>
                <span className="text-[11.5px] text-warn-text">
                  It gets the output above and installs what it can. It will not run anything
                  needing a password — it would hang where you cannot see it — and it does not sign
                  you in to anything: that needs your browser and your password, and is yours to do.
                </span>
              </div>
            ) : (
              <span className="text-[11.5px] text-warn-text">
                Install Claude Code or Codex first and the agent can finish the rest itself.
              </span>
            )}
          </div>
        )}

        {/* Homebrew is not a tool mvpfy uses — it is how three of the others
            get installed, so it only appears while it is the thing in the way. */}
        {brewPlan?.available && (
          <div className="flex items-center gap-3 border-t border-line-subtle pt-3">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-text" />
            <span className="w-24 text-[13px] font-medium">Homebrew</span>
            <span className="min-w-0 flex-1 text-[11.5px] text-muted">
              Needed to install the GitHub CLI, Docker and Node.
            </span>
            <button
              onClick={() => install('brew')}
              disabled={toolRun !== null}
              title={brewPlan.command}
              className="btn-primary h-6 shrink-0 px-2.5 text-[11.5px] disabled:opacity-50"
            >
              {toolRun?.tool === 'brew' ? 'In Terminal…' : 'Install…'}
            </button>
          </div>
        )}
        {toolRun && (
          <>
            {toolRun.kind === 'install' && planFor(toolRun.tool) && (
              <p className="text-[11.5px] text-muted">
                <code className="font-mono text-body">{planFor(toolRun.tool)!.command}</code> —{' '}
                {planFor(toolRun.tool)!.note}
              </p>
            )}
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-line-subtle bg-sunken p-3 font-mono text-[11.5px] leading-relaxed text-body">
              {toolLog ||
                (toolRun.kind === 'install' ? 'Starting…' : 'Opening your browser to sign in…')}
            </pre>
          </>
        )}
        {plans.length === 0 && cliStatuses.some((c) => !c.found) && (
          <p className="text-[11.5px] text-muted">
            One-click install is macOS-only for now — the command is shown beside each tool.
          </p>
        )}
        {cliStatuses.length === 0 && <p className="text-[13px] text-muted">Checking…</p>}
      </section>

      <div className="section-label mb-3">Connect your tools</div>
      <section className="card mb-7 flex flex-col gap-4 px-[18px] py-4">
        <div className="flex items-center gap-4">
          <span
            className={`mt-[7px] h-1.5 w-1.5 shrink-0 self-start rounded-full ${
              state.tenant ? 'bg-go' : 'bg-dot-idle'
            }`}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">
              Feature1 <span className="ml-1 text-[10px] text-faint">optional</span>
            </p>
            <p className="text-[12.5px] text-muted">
              {state.tenant
                ? 'Pull your user stories into the board and push pull requests back.'
                : 'Paste your Feature1 address to pull your user stories into mvpfy.'}
            </p>
          </div>
          {state.tenant ? (
            <div className="flex shrink-0 items-center gap-3">
              <span className="font-mono text-[11.5px] text-go">{state.tenant.host}</span>
              <button
                onClick={login.disconnect}
                className="text-[11.5px] text-muted hover:text-ink"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <input
                value={login.address}
                onChange={(e) => login.setAddress(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void login.connect()}
                placeholder="acme.feature1.ai"
                spellCheck={false}
                className="h-[30px] w-48 rounded-md border border-line px-2.5 font-mono text-[12px] outline-none focus:border-muted"
              />
              <button
                onClick={() => void login.connect()}
                disabled={login.status === 'waiting' || !login.address.trim()}
                className="btn-primary h-[30px] px-3 text-[12.5px] disabled:opacity-50"
              >
                {login.status === 'waiting' ? 'Waiting…' : 'Connect'}
              </button>
            </div>
          )}
        </div>
        {login.status === 'error' && login.error && (
          <p className="text-[12.5px] text-danger">{login.error}</p>
        )}
        <div className="border-t border-line-subtle" />
        <div className="flex items-center gap-4">
          <span
            className={`mt-[7px] h-1.5 w-1.5 shrink-0 self-start rounded-full ${
              gh?.authenticated ? 'bg-go' : 'bg-dot-idle'
            }`}
          />
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
              not signed in — use <span className="text-body">Sign in</span> under Required tools
            </span>
          )}
        </div>
      </section>

      <div className="section-label mb-3">Agent</div>
      <section className="card mb-7 flex flex-col gap-4 px-[18px] py-4">
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
            <p className="text-[13.5px] font-medium">Claude model</p>
            <p className="text-[12.5px] text-muted">
              Used only when the default agent is Claude Code. Leave on default to use whatever{' '}
              <code className="font-mono">claude</code> is already set to.
            </p>
          </div>
          <ModelPicker
            value={state.settings.claudeModel}
            models={models.claude}
            onChange={(claudeModel) =>
              updateState((prev) => ({ ...prev, settings: { ...prev.settings, claudeModel } }))
            }
          />
        </div>
        <div className="border-t border-line-subtle" />
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">Codex model</p>
            <p className="text-[12.5px] text-muted">Used only when the default agent is Codex.</p>
          </div>
          <ModelPicker
            value={state.settings.codexModel}
            models={models.codex}
            onChange={(codexModel) =>
              updateState((prev) => ({ ...prev, settings: { ...prev.settings, codexModel } }))
            }
          />
        </div>
      </section>

      <div className="section-label mb-3">New products</div>
      <section className="card flex flex-col gap-2 px-[18px] py-4">
        <p className="text-[13.5px] font-medium">Built with</p>
        <p className="text-[12.5px] text-muted">
          Only used for a project whose repository is still empty. Once there is code, mvpfy reads
          it and matches what is already there — this is never consulted again.
        </p>
        <input
          value={state.settings.defaultStack}
          onChange={(e) =>
            updateState((prev) => ({
              ...prev,
              settings: { ...prev.settings, defaultStack: e.target.value },
            }))
          }
          placeholder={DEFAULT_STACK}
          spellCheck={false}
          className="h-[34px] rounded-md border border-line bg-surface px-[11px] text-[12.5px] outline-none placeholder:text-faint focus:border-muted"
        />
        <p className="text-xs text-muted">
          Leave it blank to use the default. Change it before the first story is implemented — after
          that the code decides.
        </p>
      </section>

      <div className="section-label mb-3">Workspace</div>
      <section className="card flex flex-col gap-2 px-[18px] py-4">
        <p className="text-[13.5px] font-medium">Projects folder</p>
        <div className="flex h-[34px] items-center rounded-md border border-line bg-sunken px-[11px] font-mono text-[12.5px] text-body">
          ~/.mvpfy/projects
        </div>
        <p className="text-xs text-muted">
          Each project takes the next free port when it is bootstrapped.
        </p>
      </section>

      <div className="section-label mb-3 mt-7">About</div>
      <section className="card flex flex-col gap-3 px-[18px] py-4">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">
              mvpfy <span className="font-mono text-[12.5px] text-body">{version || '—'}</span>
            </p>
            <p className="text-[12.5px] text-muted">{updateLine}</p>
          </div>
          {/* Downloaded: the only thing left is the restart, so that is the
              button. macOS cannot install an unsigned update, so there an
              available one sends you to the download instead. */}
          {update?.kind === 'downloaded' ? (
            <button
              onClick={() => void window.mvpfy.installUpdate()}
              className="btn-primary h-[30px] shrink-0 px-3 text-[12.5px]"
            >
              Restart to update
            </button>
          ) : update?.kind === 'available' ? (
            <button
              onClick={() =>
                void window.mvpfy.openExternal(
                  update.version ? macInstallerUrl(update.version) : RELEASES_URL
                )
              }
              className="btn-primary h-[30px] shrink-0 px-3 text-[12.5px]"
            >
              Download {update.version ?? ''} ↗
            </button>
          ) : (
            <button
              onClick={() => {
                setChecking(true);
                setUpdate(null);
                void window.mvpfy
                  .checkForUpdates()
                  .then(setUpdate)
                  .finally(() => setChecking(false));
              }}
              disabled={checking}
              className="btn-secondary h-[30px] shrink-0 px-3 text-[12.5px] disabled:opacity-50"
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}
          <button
            onClick={() => void window.mvpfy.openExternal(RELEASES_URL)}
            className="shrink-0 text-[12.5px] text-go hover:underline"
          >
            Release notes ↗
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Pick a model, from what the CLI itself advertises.
 *
 * Neither agent can list its models, so this is whatever their --help names.
 * When that comes back empty the field stays free text rather than offering a
 * guess: a wrong list is worse than no list, since it would hide the model the
 * user actually wants.
 */
function ModelPicker({
  value,
  models,
  onChange,
}: {
  value: string;
  models: string[];
  onChange: (value: string) => void;
}) {
  // A state file written before this setting existed has no value at all;
  // treat that as the default rather than as a model named "undefined".
  const current = value ?? '';
  const known = current === '' || models.includes(current);
  const [custom, setCustom] = useState(false);
  const typing = custom || !known;

  if (models.length === 0 || typing) {
    return (
      <input
        value={current}
        onChange={(e) => onChange(e.target.value.trim())}
        onBlur={() => setCustom(false)}
        placeholder="default"
        spellCheck={false}
        autoFocus={custom}
        className="h-[34px] w-44 shrink-0 rounded-md border border-line px-[11px] font-mono text-[12.5px] outline-none placeholder:text-faint focus:border-muted"
      />
    );
  }
  return (
    <select
      value={current}
      onChange={(e) => {
        if (e.target.value === '__custom__') {
          setCustom(true);
          return;
        }
        onChange(e.target.value);
      }}
      className="h-[34px] w-44 shrink-0 rounded-md border border-line bg-surface px-2 font-mono text-[12.5px]"
    >
      <option value="">default</option>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value="__custom__">Other…</option>
    </select>
  );
}
