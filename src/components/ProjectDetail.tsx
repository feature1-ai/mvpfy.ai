import { useCallback, useEffect, useState } from 'react';
import {
  ANSWERS_FILE,
  GENERATED_FILES,
  MvpfyState,
  Project,
  QUESTIONS_FILE,
  RepoFile,
} from '../../shared/types';
import {
  startBootstrapRun,
  startDockerRun,
  startShipFeatureRun,
} from '../lib/agentRunner';
import { Feature1McpClient, UserStory } from '../lib/feature1Mcp';
import { RunsApi } from '../lib/useRuns';
import LogPanel from './LogPanel';

interface Props {
  project: Project;
  state: MvpfyState;
  updateState: (mutate: (prev: MvpfyState) => MvpfyState) => void;
  runsApi: RunsApi;
}

export default function ProjectDetail({ project, state, updateState, runsApi }: Props) {
  const [files, setFiles] = useState<RepoFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [stories, setStories] = useState<UserStory[]>([]);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [loadingStories, setLoadingStories] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answersDraft, setAnswersDraft] = useState('');
  const [appHealthy, setAppHealthy] = useState(false);
  const [targetRepoDir, setTargetRepoDir] = useState(
    project.repos[0]?.dir ?? project.localPath
  );

  const latestRun = runsApi.latestForProject(project.id);
  const busy = latestRun?.running ?? false;
  const lastShipRun = Object.values(runsApi.runs)
    .filter((r) => r.handle.projectId === project.id && r.handle.kind === 'ship')
    .pop();

  const refreshFiles = useCallback(() => {
    void window.mvpfy
      .readRepoFiles(project.localPath, [...GENERATED_FILES, QUESTIONS_FILE, ANSWERS_FILE])
      .then((result) => {
        setFiles(result);
        const viewable = result
          .filter((f) => f.exists && f.relativePath !== QUESTIONS_FILE)
          .map((f) => f.relativePath);
        setActiveFile((prev) => (prev && viewable.includes(prev) ? prev : viewable[0] ?? null));
        const generated = result
          .filter((f) => f.exists && (GENERATED_FILES as readonly string[]).includes(f.relativePath))
          .map((f) => f.relativePath);
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, generatedFiles: generated } : p
          ),
        }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.localPath]);

  // Load files on mount and again whenever a run for this project finishes.
  useEffect(() => {
    if (!busy) refreshFiles();
  }, [busy, refreshFiles]);

  // While the environment is up, poll the app port until it answers HTTP so
  // the PM can see when it is actually ready, not just when compose exited.
  useEffect(() => {
    if (project.status !== 'running') {
      setAppHealthy(false);
      return;
    }
    let cancelled = false;
    const url = `http://localhost:${project.basePort}`;
    const check = async () => {
      const res = await window.mvpfy.probeUrl(url);
      if (!cancelled && res.reachable) setAppHealthy(true);
    };
    void check();
    const timer = setInterval(() => {
      if (!appHealthy) void check();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project.status, project.basePort, appHealthy]);

  const hasMvpfyYml = files.some((f) => f.relativePath === 'mvpfy.yml' && f.exists);
  const questionsFile = files.find((f) => f.relativePath === QUESTIONS_FILE && f.exists) ?? null;
  const viewerFiles = files.filter((f) => f.exists && f.relativePath !== QUESTIONS_FILE);
  const activeFileContent = files.find((f) => f.relativePath === activeFile)?.content ?? '';

  async function guarded(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  const bootstrap = () =>
    guarded(async () => {
      // Re-verify the port right before generating: it is baked into the
      // compose file, so it must be genuinely free at bootstrap time.
      const freePort = await window.mvpfy.findFreePort(project.basePort);
      const target = { ...project, basePort: freePort };
      const handle = await startBootstrapRun(target, state.settings);
      runsApi.track(handle);
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id ? { ...p, basePort: freePort, status: 'bootstrapping' } : p
        ),
      }));
    });

  const saveAnswersAndRerun = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, ANSWERS_FILE, answersDraft);
      setAnswersDraft('');
      await bootstrap();
    });

  const docker = (action: 'up' | 'down') =>
    guarded(async () => {
      const handle = await startDockerRun(project, action);
      runsApi.track(handle);
    });

  const refreshStories = () =>
    guarded(async () => {
      if (!state.tenant) {
        setStoriesError('Connect Feature1 in Settings first.');
        return;
      }
      setLoadingStories(true);
      setStoriesError(null);
      try {
        const token = await window.mvpfy.keychainGet(state.tenant.tokenKeychainEntry);
        const client = new Feature1McpClient(state.tenant.slug, token);
        setStories(await client.listUserStories());
      } catch (err) {
        setStoriesError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingStories(false);
      }
    });

  const implement = (story: UserStory) =>
    guarded(async () => {
      const handle = await startShipFeatureRun(project, story.id, state.settings, targetRepoDir);
      runsApi.track(handle);
    });

  const projectName = project.localPath.split('/').pop();
  const appUrl = `http://localhost:${project.basePort}`;

  return (
    <div className="flex flex-col gap-5 p-6">
      <header>
        <h2 className="text-lg font-bold">{projectName}</h2>
        {project.repos.map((r) => (
          <p key={r.url} className="text-sm text-slate-500">
            {r.url}
            {project.repos.length > 1 && (
              <span className="ml-2 text-xs text-slate-400">→ {r.dir.split('/').pop()}/</span>
            )}
          </p>
        ))}
        <p className="text-xs text-slate-400">{project.localPath}</p>
        <p className="mt-1 text-sm">
          <span className="text-slate-500">App URL: </span>
          <button
            onClick={() => void window.mvpfy.openExternal(appUrl)}
            className="font-mono text-blue-600 hover:underline"
            title="Open in browser"
          >
            {appUrl}
          </button>
          <span
            className={`ml-2 inline-block h-2 w-2 rounded-full align-middle ${
              appHealthy ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
            title={appHealthy ? 'App is responding' : 'App is not responding yet'}
          />
        </p>
      </header>

      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Environment
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void bootstrap()}
            disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Bootstrap environment
          </button>
          <button
            onClick={() => void docker('up')}
            disabled={busy || !hasMvpfyYml}
            title={
              hasMvpfyYml
                ? 'Runs docker compose -f docker-compose.mvpfy.yml up -d'
                : 'Bootstrap first, then review the generated files'
            }
            className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {project.status === 'needs-review' ? 'Reviewed — start environment' : 'Start environment'}
          </button>
          <button
            onClick={() => void docker('down')}
            disabled={busy || project.status !== 'running'}
            className="rounded-md bg-slate-600 px-3 py-2 text-sm font-medium text-white hover:bg-slate-500 disabled:opacity-50"
          >
            Stop environment
          </button>
          {project.status === 'running' &&
            (appHealthy ? (
              <button
                onClick={() =>
                  void window.mvpfy.openExternal(`http://localhost:${project.basePort}`)
                }
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
              >
                ● App is up — open localhost:{project.basePort} ↗
              </button>
            ) : (
              <span className="animate-pulse rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700">
                Waiting for the app to respond on port {project.basePort}…
              </span>
            ))}
        </div>
        {project.status === 'needs-review' && (
          <p className="mt-2 text-xs text-amber-700">
            Review the generated files below before starting the environment. Nothing runs until
            you click start.
          </p>
        )}
      </section>

      {questionsFile && !busy && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-700">
            The agent needs your input
          </h3>
          <pre className="mb-3 whitespace-pre-wrap rounded-md bg-white p-3 text-sm text-slate-800">
            {questionsFile.content}
          </pre>
          <textarea
            value={answersDraft}
            onChange={(e) => setAnswersDraft(e.target.value)}
            placeholder={'Answer the questions here, e.g.\n1. The backend repo is https://github.com/org/api\n2. Use any test key'}
            rows={4}
            className="mb-2 w-full rounded-md border border-amber-200 p-3 font-mono text-sm focus:border-amber-400 focus:outline-none"
          />
          <button
            onClick={() => void saveAnswersAndRerun()}
            disabled={!answersDraft.trim()}
            className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            Save answers & re-run bootstrap
          </button>
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Generated files
          </h3>
          <button
            onClick={refreshFiles}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            Refresh
          </button>
        </div>
        {viewerFiles.length === 0 ? (
          <p className="text-sm text-slate-400">
            No generated files yet. Run “Bootstrap environment” to create them.
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-1">
              {viewerFiles.map((f) => (
                  <button
                    key={f.relativePath}
                    onClick={() => setActiveFile(f.relativePath)}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      activeFile === f.relativePath
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {f.relativePath}
                  </button>
                ))}
            </div>
            <pre className="max-h-64 overflow-auto rounded-md bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">
              {activeFileContent}
            </pre>
          </>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Feature1 stories
          </h3>
          <div className="flex items-center gap-3">
            {project.repos.length > 1 && (
              <label className="flex items-center gap-1 text-xs text-slate-500">
                Implement in
                <select
                  value={targetRepoDir}
                  onChange={(e) => setTargetRepoDir(e.target.value)}
                  className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                >
                  {project.repos.map((r) => (
                    <option key={r.dir} value={r.dir}>
                      {r.dir.split('/').pop()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              onClick={() => void refreshStories()}
              disabled={loadingStories}
              className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50"
            >
              {loadingStories ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        {storiesError && <p className="mb-2 text-sm text-red-600">{storiesError}</p>}
        {stories.length === 0 && !storiesError ? (
          <p className="text-sm text-slate-400">
            {state.tenant
              ? 'Click refresh to load stories from Feature1.'
              : 'Connect Feature1 in Settings to load stories.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {stories.map((story) => (
              <li key={story.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="mr-2 font-mono text-xs text-slate-500">{story.code}</span>
                  <span className="text-sm">{story.title}</span>
                  <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                    {story.status}
                  </span>
                </div>
                <button
                  onClick={() => void implement(story)}
                  disabled={busy}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  Implement
                </button>
              </li>
            ))}
          </ul>
        )}
        {lastShipRun?.prUrl && (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
            Pull request ready:{' '}
            <button
              onClick={() => void window.mvpfy.openExternal(lastShipRun.prUrl!)}
              className="font-medium text-emerald-700 underline"
            >
              {lastShipRun.prUrl}
            </button>
          </div>
        )}
      </section>

      <section>
        <LogPanel run={latestRun} onStop={runsApi.stop} />
      </section>
    </div>
  );
}
