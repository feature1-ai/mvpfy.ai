import { useState } from 'react';
import { MvpfyState, Project, ProjectStatus } from '../../shared/types';
import { allocateBasePort, newProjectId } from '../lib/state';

const STATUS_STYLES: Record<ProjectStatus, string> = {
  cloned: 'bg-slate-200 text-slate-700',
  bootstrapping: 'bg-blue-100 text-blue-700',
  'needs-review': 'bg-amber-100 text-amber-800',
  running: 'bg-emerald-100 text-emerald-700',
  stopped: 'bg-slate-200 text-slate-700',
  error: 'bg-red-100 text-red-700',
};

interface Props {
  state: MvpfyState;
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
  updateState: (mutate: (prev: MvpfyState) => MvpfyState) => void;
}

export default function ProjectList({ state, selectedProjectId, onSelect, updateState }: Props) {
  const [repoUrlsText, setRepoUrlsText] = useState('');
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addProject() {
    const urls = repoUrlsText
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0 || cloning) return;
    setCloning(true);
    setError(null);
    try {
      const result = await window.mvpfy.createProject(urls);
      if (!result.ok) {
        setError(result.error || 'Clone failed');
        return;
      }
      const project: Project = {
        id: newProjectId(),
        repos: result.repos.map(({ url, dir }) => ({ url, dir })),
        localPath: result.workspacePath,
        basePort: await allocateBasePort(state),
        status: 'cloned',
        lastStoryId: null,
        generatedFiles: [],
      };
      updateState((prev) => ({ ...prev, projects: [...prev.projects, project] }));
      setRepoUrlsText('');
      onSelect(project.id);
    } finally {
      setCloning(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add project
        </h2>
        <div className="flex flex-col gap-2">
          <textarea
            value={repoUrlsText}
            onChange={(e) => setRepoUrlsText(e.target.value)}
            placeholder={
              'Repo URL or local path, one per line:\nhttps://github.com/org/frontend\n~/projects/backend'
            }
            rows={3}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            disabled={cloning}
          />
          <div className="flex gap-2">
            <button
              onClick={() => void addProject()}
              disabled={cloning || !repoUrlsText.trim()}
              className="flex-1 rounded-md bg-brand-dark px-3 py-2 text-sm font-medium text-white hover:bg-brand disabled:opacity-50"
            >
              {cloning ? 'Cloning…' : 'Add project'}
            </button>
            <button
              onClick={() =>
                void window.mvpfy.pickDirectory().then((dir) => {
                  if (dir) {
                    setRepoUrlsText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${dir}` : dir));
                  }
                })
              }
              disabled={cloning}
              title="Add a local repository folder"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              Browse…
            </button>
          </div>
          {error && <p className="whitespace-pre-wrap text-xs text-red-600">{error}</p>}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Projects
        </h2>
        {state.projects.length === 0 && <p className="text-sm text-slate-400">No projects yet.</p>}
        <ul className="flex flex-col gap-1">
          {state.projects.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => onSelect(p.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  p.id === selectedProjectId
                    ? 'bg-slate-100 ring-1 ring-slate-300'
                    : 'hover:bg-slate-50'
                }`}
              >
                <span className="block truncate font-medium">
                  {p.localPath.split('/').pop()}
                  {p.repos.length > 1 && (
                    <span className="ml-1 text-xs font-normal text-slate-400">
                      ({p.repos.length} repos)
                    </span>
                  )}
                </span>
                <span
                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[p.status]}`}
                >
                  {p.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
