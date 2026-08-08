import * as fs from 'node:fs';
import { DEFAULT_STATE, MvpfyState, Project } from '../../shared/types';
import { ensureDirs, STATE_FILE } from '../paths';

/** Persistent app state (~/.mvpfy/state.json) — the app's Model. */

export function readState(): MvpfyState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MvpfyState>;
    return {
      tenant: parsed.tenant ?? null,
      projects: migrateProjects(parsed.projects ?? []),
      settings: { ...DEFAULT_STATE.settings, ...parsed.settings },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function writeState(state: MvpfyState): void {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
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
