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

/**
 * Pick a host port for a new project: ask the OS for a genuinely free one,
 * starting above ports already promised to other projects.
 */
export async function allocateBasePort(state: MvpfyState): Promise<number> {
  const maxUsed = Math.max(4099, ...state.projects.map((p) => p.basePort));
  return window.mvpfy.findFreePort(maxUsed + 1);
}

export function newProjectId(): string {
  return `prj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
