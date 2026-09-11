import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MvpfyState, Project } from '../../shared/types';
import { UpdateState, useProjectController } from '../hooks/useProjectController';
import { RunsApi } from '../lib/useRuns';
import AgentView from './AgentView';
import LogPanel from '../components/LogPanel';
import OverviewView from './OverviewView';
import PlanView from './PlanView';

export type ProjectTab = 'overview' | 'plan' | 'agent' | 'app' | 'code' | 'logs';

interface Props {
  project: Project;
  state: MvpfyState;
  updateState: UpdateState;
  runsApi: RunsApi;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
}

export default function ProjectShell({
  project,
  state,
  updateState,
  runsApi,
  tab,
  onTabChange,
}: Props) {
  const c = useProjectController(project, state, updateState, runsApi);
  const mvpfyYml = c.viewerFiles.find((f) => f.relativePath === 'mvpfy.yml')?.content ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appWebview = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ideWebview = useRef<any>(null);

  // Auto-follow container logs when the PM opens the Logs tab of a running
  // environment; stays running until stopped or the environment goes down.
  const appLogsActive = c.appLogsRun?.running === true;

  // Follows the newest run until the user picks one, then stays where they
  // put it — a log being read should not be swapped out underneath them.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const shownRun =
    (pickedRunId && c.runHistory.find((r) => r.handle.runId === pickedRunId)) || c.latestRun;
  useEffect(() => {
    if (tab === 'logs' && project.status === 'running' && !appLogsActive) {
      void c.startAppLogs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, project.status]);

  const tabs: Array<{ id: ProjectTab; label: string; hint?: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'plan', label: 'Plan' },
    { id: 'agent', label: 'Agent' },
    { id: 'app', label: 'App', hint: `:${project.basePort}` },
    { id: 'code', label: 'Code' },
    { id: 'logs', label: 'Logs' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="sticky top-[52px] z-[15] flex h-11 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={`flex h-[43px] items-center gap-[7px] border-b-2 px-3.5 text-[13px] ${
              tab === t.id
                ? 'border-ink font-semibold text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.label}
            {t.hint && <span className="font-mono text-[11px] text-faint">{t.hint}</span>}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3.5 text-xs">
          {tab === 'app' && c.appHealthy && (
            <>
              <span className="flex h-7 items-center gap-1.5 rounded-md border border-go-border bg-go-bgalt px-[11px] font-mono text-xs text-go">
                <span className="h-1.5 w-1.5 rounded-full bg-go" />
                localhost:{project.basePort}
              </span>
              <button
                onClick={() => appWebview.current?.reloadIgnoringCache?.()}
                className="text-go hover:text-go-hover hover:underline"
                title="Force refresh — reloads the app ignoring cached files"
              >
                Refresh
              </button>
              <button
                onClick={() => c.openExternal(c.appUrl)}
                className="text-go hover:text-go-hover hover:underline"
              >
                Open in browser ↗
              </button>
            </>
          )}
          {tab === 'code' && c.ideUrl && (
            <>
              <button
                onClick={() => ideWebview.current?.reload?.()}
                className="text-go hover:text-go-hover hover:underline"
              >
                Reload
              </button>
              <button
                onClick={() => c.ideUrl && c.openExternal(c.ideUrl)}
                className="text-go hover:text-go-hover hover:underline"
              >
                Open in browser ↗
              </button>
              <button
                onClick={() => void c.stopIde()}
                disabled={c.busy}
                className="text-danger hover:text-danger-hover disabled:opacity-50"
              >
                Stop IDE
              </button>
            </>
          )}
        </div>
      </nav>

      <div className="relative min-h-0 flex-1">
        {/* Overview and Logs are plain panes; App/Code hold persistent webviews.
            All stay mounted and stack by z-index — hiding a webview with
            display/visibility freezes its guest at the wrong size. */}
        <Pane active={tab === 'overview'} scroll>
          <OverviewView c={c} mvpfyYml={mvpfyYml} onOpenTab={(t) => onTabChange(t)} />
        </Pane>

        <Pane active={tab === 'plan'} scroll>
          <PlanView c={c} onOpenTab={(t) => onTabChange(t)} />
        </Pane>

        <Pane active={tab === 'agent'} scroll>
          <AgentView c={c} agent={state.settings.defaultAgent} />
        </Pane>

        <Pane active={tab === 'app'}>
          {c.appHealthy ? (
            <div className="h-full p-4">
              <div className="h-full overflow-hidden rounded-[10px] border border-line bg-surface">
                <webview
                  ref={appWebview}
                  src={c.appUrl}
                  partition="persist:mvpfy-embedded"
                  style={{ display: 'flex', width: '100%', height: '100%' }}
                />
              </div>
            </div>
          ) : (
            <Placeholder
              title={
                project.status === 'running' ? 'Waiting for the app…' : 'The app is not running'
              }
              body={
                project.status === 'running'
                  ? `Waiting for localhost:${project.basePort} to answer.`
                  : 'Start the environment from Overview and the running app will appear here.'
              }
              action={{ label: 'Go to Overview', onClick: () => onTabChange('overview') }}
            />
          )}
        </Pane>

        <Pane active={tab === 'code'}>
          {c.ideUrl && c.ideHealthy ? (
            <div className="h-full p-4">
              <div className="h-full overflow-hidden rounded-[10px] border border-line bg-surface">
                <webview
                  ref={ideWebview}
                  src={c.ideUrl}
                  partition="persist:mvpfy-embedded"
                  style={{ display: 'flex', width: '100%', height: '100%' }}
                />
              </div>
            </div>
          ) : c.ideUrl || c.ideStarting ? (
            <Placeholder
              title="Starting the editor…"
              body="First launch downloads the editor image (~300 MB)."
            />
          ) : c.ideError ? (
            /* A failed launch used to look exactly like one never attempted:
               the button came back and nothing said why. Docker's own words
               are what makes this reportable. */
            <div className="mx-auto flex h-full w-full max-w-[720px] flex-col justify-center px-8">
              <h2 className="text-[15px] font-semibold">The editor did not start</h2>
              <p className="mt-1 text-[13px] text-body">
                Docker could not run the editor container. Its output is below.
              </p>
              <pre className="mt-3 max-h-[280px] overflow-auto rounded-lg border border-line bg-sunken p-3 font-mono text-[11.5px] leading-relaxed text-body">
                {c.ideError}
              </pre>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => void c.startIde()}
                  disabled={c.busy}
                  className="btn-primary h-[34px] px-3.5 text-[13px] disabled:opacity-50"
                >
                  Try again
                </button>
                <span className="text-xs text-muted">
                  Docker Desktop needs to be running before the editor can start.
                </span>
              </div>
            </div>
          ) : (
            <Placeholder
              title="Open the code in VS Code"
              body="Runs the open-source code-server editor in Docker with this project mounted — read and edit the code right here."
              action={{
                label: 'Launch editor',
                onClick: () => void c.startIde(),
                primary: true,
                disabled: c.busy,
              }}
            />
          )}
        </Pane>

        <Pane active={tab === 'logs'} scroll>
          <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-6 pb-16 pt-6">
            <div>
              <div className="mb-2 flex items-center gap-3">
                <span className="section-label">App logs</span>
                <span className="text-[11px] text-faint">
                  live output from the running containers
                </span>
                {project.status === 'running' && !appLogsActive && (
                  <button
                    onClick={() => void c.startAppLogs()}
                    className="ml-auto text-xs text-go hover:text-go-hover hover:underline"
                  >
                    Start streaming
                  </button>
                )}
              </div>
              {c.appLogsRun ? (
                <LogPanel
                  run={c.appLogsRun}
                  onStop={c.stopRun}
                  heightClass="h-[400px]"
                  title="app logs"
                />
              ) : (
                <div className="card px-5 py-6 text-[13px] text-muted">
                  {project.status === 'running'
                    ? 'Starting the log stream…'
                    : 'Start the environment to stream its logs here.'}
                </div>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center gap-3">
                <span className="section-label">Activity</span>
                <span className="text-[11px] text-faint">
                  agent runs, bootstraps, and environment commands
                </span>
                {/* Every run is kept for the session. Showing only the newest
                    meant the log explaining a failure disappeared the moment
                    anything else ran — which is exactly when it is wanted. */}
                {c.runHistory.length > 1 && (
                  <select
                    value={shownRun?.handle.runId ?? ''}
                    onChange={(e) => setPickedRunId(e.target.value)}
                    className="ml-auto h-7 max-w-[280px] rounded-md border border-line bg-surface px-2 text-xs"
                  >
                    {[...c.runHistory].reverse().map((run, i) => (
                      <option key={run.handle.runId} value={run.handle.runId}>
                        {i === 0 ? 'Latest — ' : ''}
                        {RUN_LABELS[run.handle.kind] ?? run.handle.kind}
                        {run.running ? ' · running' : run.exitCode === 0 ? '' : ' · failed'}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <LogPanel run={shownRun} onStop={c.stopRun} />
            </div>
          </div>
        </Pane>
      </div>
    </div>
  );
}

/** What each kind of run is called, for someone reading their own logs. */
const RUN_LABELS: Record<string, string> = {
  'bootstrap-plan': 'Working out what the app needs',
  bootstrap: 'Setting the app up',
  'docker-up': 'Starting the environment',
  'docker-down': 'Stopping the environment',
  'ide-up': 'Starting the editor',
  'ide-down': 'Stopping the editor',
  seed: 'Adding the demo login and sample data',
  triage: 'Diagnosing a failure',
  instruct: 'Making a change',
  sync: 'Syncing repositories',
  readiness: 'Checking launch readiness',
  'readiness-fix': 'Fixing a readiness finding',
  'launch-plan': 'Pricing a launch',
  'plan-spec': 'Writing a product spec',
  'plan-story': 'Implementing a story',
  ship: 'Shipping a pull request',
};

function Pane({
  active,
  scroll,
  children,
}: {
  active: boolean;
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`absolute inset-0 ${scroll ? 'overflow-y-auto' : 'overflow-hidden'} bg-paper`}
      style={{ zIndex: active ? 2 : 0, pointerEvents: active ? 'auto' : 'none' }}
    >
      {children}
    </div>
  );
}

function Placeholder({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void; primary?: boolean; disabled?: boolean };
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-1 max-w-[420px] text-[13px] leading-normal text-body [text-wrap:pretty]">
        {body}
      </p>
      {action && (
        <button
          onClick={action.onClick}
          disabled={action.disabled}
          className={`${action.primary ? 'btn-primary' : 'btn-secondary'} mt-4 h-[34px] px-4 disabled:opacity-50`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
