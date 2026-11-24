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
 * How many host ports each project owns, starting at its base port. A stack
 * publishes more than its app — an API, a database, a mail inbox, a dev
 * server — and the setup agent is told to keep all of them inside this block.
 */
export const PORT_BLOCK = 10;

/**
 * Where the next project's block starts: the first multiple of PORT_BLOCK
 * clear of every existing project's whole block. Older projects' bases are
 * not round (4101, 4112), so their blocks end mid-decade and the next round
 * number after the base is not enough.
 *
 * It used to be the highest base plus one. A project only records its base,
 * so the ports its other services use were invisible: a project on 4101 also
 * published its API on 4102, the next project was handed 4102 because
 * the first happened to be stopped at that moment, and the two could never
 * run together after that.
 */
export function nextPortBlock(bases: number[]): number {
  if (bases.length === 0) return 4100;
  const highest = Math.max(...bases);
  return Math.ceil((highest + PORT_BLOCK) / PORT_BLOCK) * PORT_BLOCK;
}

/**
 * Pick a host port for a new project: ask the OS for a genuinely free one,
 * starting at the first block no other project owns.
 */
export async function allocateBasePort(state: MvpfyState): Promise<number> {
  return window.mvpfy.findFreePort(nextPortBlock(state.projects.map((p) => p.basePort)));
}

export function newProjectId(): string {
  return `prj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
