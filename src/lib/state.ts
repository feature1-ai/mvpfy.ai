import { MvpfyState, Project } from '../../shared/types';

export async function loadState(): Promise<MvpfyState> {
  return window.mvpfy.readState();
}

export async function saveState(state: MvpfyState): Promise<MvpfyState> {
  await window.mvpfy.writeState(state);
  return state;
}

export function withProject(
  state: MvpfyState,
  projectId: string,
  patch: Partial<Project>
): MvpfyState {
  return {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, ...patch } : p)),
  };
}

/** Pick a host port for a new project, spaced out to leave room for sidecars. */
export function nextBasePort(state: MvpfyState): number {
  const used = new Set(state.projects.map((p) => p.basePort));
  let port = 4100;
  while (used.has(port)) port += 10;
  return port;
}

export function newProjectId(): string {
  return `prj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
