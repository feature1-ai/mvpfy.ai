import { useState } from 'react';
import { MvpfyState, Project } from '../../shared/types';
import { UpdateState } from '../hooks/useProjectController';
import { allocateBasePort, newProjectId } from '../lib/state';

interface Props {
  state: MvpfyState;
  updateState: UpdateState;
  onCreated: (projectId: string) => void;
}

const STEPS = [
  ['01', 'Add & inspect', 'Detects services, ports and dependencies.'],
  ['02', 'Bootstrap', 'Starts on its own: writes mvpfy.yml, a compose file and demo logins.'],
  ['03', 'Run', 'Brings the app up and hands you a link and a demo login to try it.'],
] as const;

export default function AddProjectView({ state, updateState, onCreated }: Props) {
  const [text, setText] = useState('');
  const [cloning, setCloning] = useState(false);
  const [inPlace, setInPlace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRun = state.projects.length === 0;
  const looksLocal = /^([~/.]|[A-Za-z]:[\\/])/.test(text.trim());

  async function add() {
    const urls = text
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0 || cloning) return;
    const link = inPlace && looksLocal;
    if (inPlace && urls.length > 1) {
      setError('In-place mode takes a single local folder (it can contain multiple repos).');
      return;
    }
    setCloning(true);
    setError(null);
    try {
      const result = await window.mvpfy.createProject(urls, link);
      if (!result.ok) {
        setError(result.error || 'Clone failed');
        return;
      }
      const project: Project = {
        id: newProjectId(),
        repos: result.repos.map(({ url, dir }) => ({ url, dir })),
        localPath: result.workspacePath,
        basePort: await allocateBasePort(state),
        // Bootstrap starts by itself once the project view opens.
        status: 'queued',
        lastStoryId: null,
        generatedFiles: [],
        mode: link ? 'linked' : 'managed',
      };
      updateState((prev) => ({ ...prev, projects: [...prev.projects, project] }));
      setText('');
      onCreated(project.id);
    } finally {
      setCloning(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[560px] px-6 pb-20 pt-24">
      <h1 className="mb-2 text-[26px] font-semibold tracking-[-0.02em]">
        {firstRun ? 'Add your first project' : 'Add a project'}
      </h1>
      <p className="mb-7 text-sm leading-relaxed text-body [text-wrap:pretty]">
        Paste one or more repositories. mvpfy adds them and sets the environment up on its own — it
        works out how to run the code, writes the run config and starts the app, which takes a few
        minutes on your agent subscription. Follow along on the cards; the last one is yours.
      </p>

      <label className="section-label mb-1.5 block">Repositories</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          'https://github.com/org/frontend\nhttps://github.com/org/backend\n~/code/local-service'
        }
        disabled={cloning}
        className="h-[104px] w-full resize-y rounded-lg border border-line bg-surface px-3.5 py-3 font-mono text-[13px] leading-[1.7] outline-none placeholder:text-faint focus:border-muted"
      />
      <div className="mt-3 flex items-center gap-2.5">
        <button
          onClick={() => void add()}
          disabled={cloning || !text.trim()}
          className="btn-primary h-[38px] px-4 text-sm disabled:opacity-50"
        >
          {cloning ? 'Adding…' : 'Add & bootstrap'}
        </button>
        <button
          onClick={() =>
            void window.mvpfy.pickDirectory().then((dir) => {
              if (dir) setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${dir}` : dir));
            })
          }
          disabled={cloning}
          className="btn-secondary h-[38px] px-4 text-sm disabled:opacity-50"
        >
          Browse local folder…
        </button>
        <span className="ml-auto text-xs text-muted">One per line</span>
      </div>
      {looksLocal && (
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-sunken px-3.5 py-3">
          <input
            type="checkbox"
            checked={inPlace}
            onChange={(e) => setInPlace(e.target.checked)}
            className="mt-0.5 accent-ink"
          />
          <span className="text-[12.5px] leading-relaxed text-body">
            <span className="font-medium text-ink">
              Use this folder in place — don&apos;t copy.
            </span>{' '}
            mvpfy works directly in your folder: the agent edits your working copy, and everything
            mvpfy generates stays inside a <span className="font-mono">.mvpfy/</span> subfolder.
            Removing the project later only removes that subfolder and the containers — never your
            code.
          </span>
        </label>
      )}
      {error && <p className="mt-3 whitespace-pre-wrap text-[13px] text-danger">{error}</p>}

      <div className="mt-10 grid gap-3.5 border-t border-line pt-6">
        {STEPS.map(([n, title, desc]) => (
          <div key={n} className="flex items-baseline gap-3.5">
            <span className="font-mono text-xs text-faint">{n}</span>
            <div>
              <span className="text-[13px] font-medium">{title}</span>
              <span className="ml-2 text-[13px] text-body">{desc}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
