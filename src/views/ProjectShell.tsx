import type { ReactNode } from 'react';
import { MvpfyState, Project } from '../../shared/types';
import { UpdateState, useProjectController } from '../hooks/useProjectController';
import { RunsApi } from '../lib/useRuns';
import LogPanel from '../components/LogPanel';
import OverviewView from './OverviewView';

export type ProjectTab = 'overview' | 'app' | 'code' | 'logs';

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

  const tabs: Array<{ id: ProjectTab; label: string; hint?: string }> = [
    { id: 'overview', label: 'Overview' },
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

        <Pane active={tab === 'app'}>
          {c.appHealthy ? (
            <div className="h-full p-4">
              <div className="h-full overflow-hidden rounded-[10px] border border-line bg-surface">
                <webview
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
          <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-6">
            <LogPanel run={c.latestRun} onStop={c.stopRun} />
          </div>
        </Pane>
      </div>
    </div>
  );
}

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
