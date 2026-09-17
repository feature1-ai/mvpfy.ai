import { useState } from 'react';
import { MvpfyState, Project } from '../../shared/types';
import { UpdateState } from '../hooks/useProjectController';
import { allocateBasePort, newProjectId } from '../lib/state';

interface Props {
  state: MvpfyState;
  updateState: UpdateState;
  onCreated: (projectId: string) => void;
}

/** Repo entries from the textarea: one per line (commas allowed too). */
function splitEntries(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

/** Absolute, home-relative, relative, or Windows drive-letter path. */
function isLocalPath(entry: string): boolean {
  return /^([~/.]|[A-Za-z]:[\\/])/.test(entry);
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
  const [source, setSource] = useState<'existing' | 'new'>('existing');
  const [newName, setNewName] = useState('');
  const [withRemote, setWithRemote] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const firstRun = state.projects.length === 0;
  const entries = splitEntries(text);
  // In-place mode works from one folder root, so it is only offered for a
  // single local entry — several repos come in as copies.
  const looksLocal = entries.length === 1 && isLocalPath(entries[0]);

  async function add() {
    const urls = entries;
    if (urls.length === 0 || cloning) return;
    const link = inPlace && looksLocal;
    if (inPlace && urls.length > 1) {
      setError(
        'In-place mode takes a single local folder. To use several repos in place, pick the folder that contains them.'
      );
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

  async function startFromScratch() {
    if (!newName.trim() || cloning) return;
    setCloning(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.mvpfy.createBlankProject(newName, withRemote);
      if (!result.ok) {
        setError(result.error || 'Could not create the project');
        return;
      }
      const project: Project = {
        id: newProjectId(),
        repos: result.repos.map(({ url, dir }) => ({ url, dir })),
        localPath: result.workspacePath,
        basePort: await allocateBasePort(state),
        // Not 'queued': that bootstraps on open, and there is nothing here to
        // work out how to run yet. The environment is set up once the first
        // story has built something — until then the button is there to press.
        status: 'cloned',
        lastStoryId: null,
        generatedFiles: [],
        mode: 'managed',
      };
      if (result.remoteError) {
        // The workspace is real and usable; only GitHub is missing. Losing the
        // project over that would be worse than saying so.
        setNotice(
          `The project was created, but GitHub was not: ${result.remoteError}\nEverything works except raising a pull request — add a remote when you are ready.`
        );
      }
      updateState((prev) => ({ ...prev, projects: [...prev.projects, project] }));
      setNewName('');
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
      <div className="mb-6 flex gap-2">
        {(
          [
            ['existing', 'I have code already'],
            ['new', 'Start something new'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => {
              setSource(key);
              setError(null);
            }}
            className={`h-[34px] rounded-md px-3.5 text-[13px] ${
              source === key
                ? 'bg-ink font-medium text-white'
                : 'border border-line text-muted hover:text-body'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {source === 'new' ? (
        <NewProductPane
          name={newName}
          onName={setNewName}
          remote={withRemote}
          onRemote={setWithRemote}
          busy={cloning}
          onCreate={() => void startFromScratch()}
        />
      ) : (
        <>
          <p className="mb-7 text-sm leading-relaxed text-body [text-wrap:pretty]">
            Paste one or more repositories. mvpfy adds them and sets the environment up on its own —
            it works out how to run the code, writes the run config and starts the app, which takes
            a few minutes on your agent subscription. Follow along on the cards; the last one is
            yours.
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
                void window.mvpfy.pickDirectory().then((dirs) => {
                  if (!dirs?.length) return;
                  setText((prev) => {
                    const existing = splitEntries(prev);
                    const added = dirs.filter((d) => !existing.includes(d));
                    return [...existing, ...added].join('\n');
                  });
                })
              }
              disabled={cloning}
              className="btn-secondary h-[38px] px-4 text-sm disabled:opacity-50"
            >
              Browse local folders…
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
                mvpfy works directly in your folder: the agent edits your working copy, and
                everything mvpfy generates stays inside a <span className="font-mono">.mvpfy/</span>{' '}
                subfolder. Removing the project later only removes that subfolder and the containers
                — never your code.
              </span>
            </label>
          )}
        </>
      )}
      {error && <p className="mt-3 whitespace-pre-wrap text-[13px] text-danger">{error}</p>}
      {notice && (
        <p className="mt-3 whitespace-pre-wrap rounded-lg border border-warn-border bg-warn-bg px-3.5 py-3 text-[12.5px] text-warn-text">
          {notice}
        </p>
      )}

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

/**
 * Starting a product that does not exist yet.
 *
 * Deliberately one field. Everything else about a new product — what it is
 * built with, how it is run — is decided later by the people and the code that
 * can actually answer it, not by a form asked before anything exists.
 */
function NewProductPane({
  name,
  onName,
  remote,
  onRemote,
  busy,
  onCreate,
}: {
  name: string;
  onName: (v: string) => void;
  remote: boolean;
  onRemote: (v: boolean) => void;
  busy: boolean;
  onCreate: () => void;
}) {
  return (
    <>
      <p className="mb-7 text-sm leading-relaxed text-body [text-wrap:pretty]">
        No repository, no code — just an idea. mvpfy makes the repository, then you plan the first
        feature and it writes the product to match. The environment is set up once there is
        something to run.
      </p>

      <label className="section-label mb-1.5 block">What are you building?</label>
      <input
        value={name}
        onChange={(e) => onName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCreate();
        }}
        placeholder="Invoice tracker"
        disabled={busy}
        className="h-[38px] w-full rounded-lg border border-line bg-surface px-3.5 text-[13.5px] outline-none placeholder:text-faint focus:border-muted"
      />

      <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-sunken px-3.5 py-3">
        <input
          type="checkbox"
          checked={remote}
          onChange={(e) => onRemote(e.target.checked)}
          className="mt-0.5 accent-ink"
        />
        <span className="text-[12.5px] leading-relaxed text-body">
          <span className="font-medium text-ink">Create a private GitHub repository.</span> Uses the
          GitHub CLI you are already signed in to. Without a remote everything works except raising
          a pull request, which has nowhere to push — you can add one later.
        </span>
      </label>

      <div className="mt-3 flex items-center gap-2.5">
        <button
          onClick={onCreate}
          disabled={busy || !name.trim()}
          className="btn-primary h-[38px] px-4 text-sm disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </>
  );
}
