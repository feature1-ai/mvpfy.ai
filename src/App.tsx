import { ReactNode, useCallback, useEffect, useState } from 'react';
import { CliStatus, MvpfyState, Project } from '../shared/types';
import ProjectList from './components/ProjectList';
import ProjectDetail from './components/ProjectDetail';
import Settings from './components/Settings';
import { checkClis } from './lib/cliCheck';
import { loadState, saveState } from './lib/state';
import { RunState, useRuns } from './lib/useRuns';
import logoUrl from '../assets/logo.svg';

type View = 'projects' | 'settings';

export default function App() {
  const [state, setState] = useState<MvpfyState | null>(null);
  const [cliStatuses, setCliStatuses] = useState<CliStatus[]>([]);
  const [view, setView] = useState<View>('projects');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [projectListCollapsed, setProjectListCollapsed] = useState(false);

  const updateState = useCallback((mutate: (prev: MvpfyState) => MvpfyState) => {
    setState((prev) => {
      if (!prev) return prev;
      const next = mutate(prev);
      void saveState(next);
      return next;
    });
  }, []);

  const onRunFinished = useCallback(
    (run: RunState) => {
      const { kind, projectId, storyId } = run.handle;
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => {
          if (p.id !== projectId) return p;
          const patch: Partial<Project> = {};
          if (kind === 'bootstrap' && run.exitCode === 0) patch.status = 'needs-review';
          if (kind === 'docker-up' && run.exitCode === 0) patch.status = 'running';
          if (kind === 'docker-down' && run.exitCode === 0) patch.status = 'stopped';
          if (kind === 'ship' && storyId) patch.lastStoryId = storyId;
          if (kind === 'ide-up') {
            patch.idePort = run.exitCode === 0 ? run.handle.port ?? null : null;
          }
          if (kind === 'ide-down' && run.exitCode === 0) patch.idePort = null;
          if (run.exitCode !== 0 && (kind === 'docker-up' || kind === 'bootstrap')) {
            patch.status = 'error';
          }
          return { ...p, ...patch };
        }),
      }));
    },
    [updateState]
  );

  const runsApi = useRuns(onRunFinished);

  const refreshClis = useCallback(() => {
    void checkClis().then(setCliStatuses);
  }, []);

  useEffect(() => {
    void loadState().then(setState);
    refreshClis();
  }, [refreshClis]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">Loading…</div>
    );
  }

  const selectedProject = state.projects.find((p) => p.id === selectedProjectId) ?? null;
  const missingClis = cliStatuses.filter((s) => !s.found || s.authenticated === false);

  return (
    <div className="flex h-full bg-slate-100 text-slate-900">
      {sidebarCollapsed ? (
        <div className="flex w-9 shrink-0 flex-col items-center bg-brand-dark py-3">
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Expand sidebar"
            className="rounded px-1 text-slate-400 hover:bg-brand hover:text-white"
          >
            »
          </button>
        </div>
      ) : (
      <aside className="flex w-52 shrink-0 flex-col bg-brand-dark text-slate-200">
        <div className="flex items-start justify-between px-4 py-5">
          <div>
            <div className="inline-block rounded-md bg-white px-2 py-1.5">
              <img src={logoUrl} alt="#mvpFY" className="h-8" />
            </div>
            <button
              onClick={() => void window.mvpfy.openExternal('https://feature1.ai')}
              className="mt-1.5 block text-xs font-medium text-slate-300 hover:text-white hover:underline"
              title="feature1.ai"
            >
              by feature1 ↗
            </button>
            <p className="text-xs text-slate-400">story → pull request</p>
          </div>
          <button
            onClick={() => setSidebarCollapsed(true)}
            title="Collapse sidebar"
            className="rounded px-1 text-slate-500 hover:bg-brand hover:text-white"
          >
            «
          </button>
        </div>
        <nav className="flex flex-col gap-1 px-2">
          <SidebarButton active={view === 'projects'} onClick={() => setView('projects')}>
            Projects
          </SidebarButton>
          <SidebarButton active={view === 'settings'} onClick={() => setView('settings')}>
            Settings
            {missingClis.length > 0 && (
              <span className="ml-2 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-slate-900">
                {missingClis.length}
              </span>
            )}
          </SidebarButton>
        </nav>
        <div className="mt-auto px-4 py-3 text-xs text-slate-500">
          {state.tenant ? `Feature1: ${state.tenant.slug}` : 'Feature1: not connected'}
        </div>
      </aside>
      )}

      <main className="flex min-w-0 flex-1">
        {view === 'settings' ? (
          <Settings
            state={state}
            cliStatuses={cliStatuses}
            onRefreshClis={refreshClis}
            updateState={updateState}
          />
        ) : (
          <>
            {projectListCollapsed ? (
              <div className="flex w-8 shrink-0 flex-col items-center border-r border-slate-200 bg-white py-3">
                <button
                  onClick={() => setProjectListCollapsed(false)}
                  title="Expand projects panel"
                  className="rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  »
                </button>
              </div>
            ) : (
              <div className="relative w-72 shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
                <button
                  onClick={() => setProjectListCollapsed(true)}
                  title="Collapse projects panel"
                  className="absolute right-2 top-3 rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  «
                </button>
                <ProjectList
                  state={state}
                  selectedProjectId={selectedProjectId}
                  onSelect={setSelectedProjectId}
                  updateState={updateState}
                />
              </div>
            )}
            <div className="min-w-0 flex-1">
              {selectedProject ? (
                <ProjectDetail
                  key={selectedProject.id}
                  project={selectedProject}
                  state={state}
                  updateState={updateState}
                  runsApi={runsApi}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-slate-400">
                  Add or select a project to get started.
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function SidebarButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
        active ? 'bg-brand text-white' : 'text-slate-300 hover:bg-brand'
      }`}
    >
      {children}
    </button>
  );
}
