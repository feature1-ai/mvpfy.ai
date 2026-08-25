import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_STATE, MvpfyState, Project } from '../../shared/types';
import { ensureDirs, setLinkedRoots, STATE_FILE } from '../paths';

/** Persistent app state (~/.mvpfy/state.json) — the app's Model. */

function syncLinkedRoots(projects: Project[]): void {
  setLinkedRoots(projects.filter((p) => p.mode === 'linked').map((p) => p.localPath));
}

/** `file` overrides the state location — production always uses STATE_FILE. */
export function readState(file: string = STATE_FILE): MvpfyState {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MvpfyState>;
    const state = {
      tenant: parsed.tenant ?? null,
      projects: migrateProjects(parsed.projects ?? []),
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
    };
    syncLinkedRoots(state.projects);
    return state;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

/** `file` overrides the state location — production always uses STATE_FILE. */
export function writeState(state: MvpfyState, file: string = STATE_FILE): void {
  if (file === STATE_FILE) ensureDirs();
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  syncLinkedRoots(state.projects);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** Migrate pre-multi-repo projects ({repoUrl} → {repos: [{url, dir}]}). */
function migrateProjects(raw: unknown[]): Project[] {
  return (raw as Array<Record<string, unknown>>).map((p) => {
    if (!p.repos && typeof p.repoUrl === 'string') {
      const { repoUrl, ...rest } = p;
      p = { ...rest, repos: [{ url: repoUrl, dir: p.localPath }] };
    }
    // A quit mid-bootstrap leaves 'bootstrapping' frozen in state with no run
    // behind it; surface it as an error so Diagnose & fix can take over.
    if (p.status === 'bootstrapping') {
      p = { ...p, status: 'error' };
    }
    return p;
  }) as unknown as Project[];
}
