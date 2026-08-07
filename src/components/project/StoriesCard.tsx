import type { ProjectController } from '../../hooks/useProjectController';

export default function StoriesCard({ c }: { c: ProjectController }) {
  const { project } = c;
  return (
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
                value={c.targetRepoDir}
                onChange={(e) => c.setTargetRepoDir(e.target.value)}
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
            onClick={() => void c.refreshStories()}
            disabled={c.loadingStories}
            className="text-xs font-medium text-brand hover:underline disabled:opacity-50"
          >
            {c.loadingStories ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>
      {c.storiesError && <p className="mb-2 text-sm text-red-600">{c.storiesError}</p>}
      {c.stories.length === 0 && !c.storiesError ? (
        <p className="text-sm text-slate-400">
          {c.tenantConnected
            ? 'Click refresh to load stories from Feature1.'
            : 'Connect Feature1 in Settings to load stories.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {c.stories.map((story) => (
            <li key={story.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="mr-2 font-mono text-xs text-slate-500">{story.code}</span>
                <span className="text-sm">{story.title}</span>
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                  {story.status}
                </span>
              </div>
              <button
                onClick={() => void c.implement(story)}
                disabled={c.busy}
                className="rounded-md bg-brand-dark px-3 py-1.5 text-xs font-medium text-white hover:bg-brand disabled:opacity-50"
              >
                Implement
              </button>
            </li>
          ))}
        </ul>
      )}
      {c.lastShipPrUrl && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
          Pull request ready:{' '}
          <button
            onClick={() => c.openExternal(c.lastShipPrUrl!)}
            className="font-medium text-emerald-700 underline"
          >
            {c.lastShipPrUrl}
          </button>
        </div>
      )}
    </section>
  );
}
