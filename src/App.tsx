import { useCallback, useEffect, useState } from 'react';
import { CliStatus, MvpfyState, Project, RELEASES_URL, UpdateStatus } from '../shared/types';
import { checkClis } from './lib/cliCheck';
import { loadState, saveState } from './lib/state';
import { RunState, useRuns } from './lib/useRuns';
import AddProjectView from './views/AddProjectView';
import ProjectShell, { ProjectTab } from './views/ProjectShell';
import SettingsView from './views/SettingsView';
import TopBar from './views/TopBar';

type Screen = 'project' | 'settings' | 'add';

export default function App() {
  const [state, setState] = useState<MvpfyState | null>(null);
  const [cliStatuses, setCliStatuses] = useState<CliStatus[]>([]);
  const [screen, setScreen] = useState<Screen>('project');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tabByProject, setTabByProject] = useState<Record<string, ProjectTab>>({});
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    return window.mvpfy.onUpdateStatus((status) => {
      if (status.kind !== 'error') setUpdateStatus(status);
    });
  }, []);

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
            patch.idePort = run.exitCode === 0 ? (run.handle.port ?? null) : null;
          }
          if (kind === 'ide-down' && run.exitCode === 0) patch.idePort = null;
          // A failed task-list run never chains into the work, so it has to
          // surface here — otherwise the project sits in 'bootstrapping'.
          if (
            run.exitCode !== 0 &&
            (kind === 'docker-up' || kind === 'bootstrap' || kind === 'bootstrap-plan')
          ) {
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
    void loadState().then((s) => {
      setState(s);
      setActiveProjectId(s.projects[0]?.id ?? null);
      if (s.projects.length === 0) setScreen('add');
    });
    refreshClis();
  }, [refreshClis]);

  if (!state) {
    return <div className="flex h-full items-center justify-center text-muted">Loading…</div>;
  }

  const activeProject =
    state.projects.find((p) => p.id === activeProjectId) ?? state.projects[0] ?? null;
  const tab: ProjectTab = activeProject
    ? (tabByProject[activeProject.id] ?? 'overview')
    : 'overview';

  return (
    <div className="flex h-full flex-col bg-paper">
      <TopBar
        projects={state.projects}
        activeProjectId={activeProject?.id ?? null}
        tenantConnected={state.tenant !== null}
        tenantSlug={state.tenant?.slug ?? null}
        onSelectProject={(id) => {
          setActiveProjectId(id);
          setScreen('project');
        }}
        onAddProject={() => setScreen('add')}
        onOpenSettings={() => setScreen('settings')}
      />

      {screen === 'settings' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SettingsView
            state={state}
            cliStatuses={cliStatuses}
            onRefreshClis={refreshClis}
            updateState={updateState}
          />
        </div>
      ) : screen === 'add' || !activeProject ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AddProjectView
            state={state}
            updateState={updateState}
            onCreated={(id) => {
              setActiveProjectId(id);
              setScreen('project');
            }}
          />
        </div>
      ) : (
        <ProjectShell
          key={activeProject.id}
          project={activeProject}
          state={state}
          updateState={updateState}
          runsApi={runsApi}
          tab={tab}
          onTabChange={(t) => setTabByProject((prev) => ({ ...prev, [activeProject.id]: t }))}
        />
      )}

      {updateStatus && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-[0_8px_24px_rgba(27,26,23,.10)]">
          <span className="text-[13px] text-body">
            {updateStatus.kind === 'downloaded'
              ? `Update ${updateStatus.version ?? ''} is ready.`
              : `Update ${updateStatus.version ?? ''} is available.`}
          </span>
          {updateStatus.kind === 'downloaded' ? (
            <button
              onClick={() => void window.mvpfy.installUpdate()}
              className="btn-primary h-[30px] px-3 text-xs"
            >
              Restart to update
            </button>
          ) : (
            <button
              onClick={() => void window.mvpfy.openExternal(RELEASES_URL)}
              className="btn-primary h-[30px] px-3 text-xs"
            >
              Download ↗
            </button>
          )}
          <button
            onClick={() => setUpdateStatus(null)}
            className="text-muted hover:text-ink"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
