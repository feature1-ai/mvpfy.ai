import { MvpfyState, Project, RepoFile } from '../../shared/types';
import { RunsApi, RunState } from '../lib/useRuns';

export type UpdateState = (mutate: (prev: MvpfyState) => MvpfyState) => void;

/** Run `action`, routing any thrown error into the shared action-error slot. */
export type Guarded = (action: () => Promise<void>) => Promise<boolean>;

/**
 * Plumbing shared by the per-resource action hooks: the project's identity,
 * app state, run tracking, loaded files, and the shared error boundary. Built
 * once per render by useProjectController and handed to each action hook.
 */
export interface ControllerContext {
  project: Project;
  state: MvpfyState;
  updateState: UpdateState;
  runsApi: RunsApi;
  /** Runs belonging to this project, in insertion order. */
  projectRuns: RunState[];
  /** Map a bare mvpfy file name to where it lives for this project's mode. */
  pf: (name: string) => string;
  files: RepoFile[];
  refreshFiles: () => void;
  guarded: Guarded;
}

/** Non-empty trimmed content of a repo file from the loaded set, or null. */
export function contentOf(files: RepoFile[], name: string): string | null {
  const f = files.find((x) => x.relativePath === name && x.exists);
  const text = f?.content?.trim();
  return text ? text : null;
}
