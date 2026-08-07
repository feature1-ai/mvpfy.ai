import type { ProjectController } from '../../hooks/useProjectController';

export default function ProjectHeader({ c }: { c: ProjectController }) {
  const { project } = c;
  return (
    <header className="relative">
      <div className="absolute right-0 top-0 flex items-center gap-2">
        {c.confirmRemove && !c.removing && (
          <>
            <span className="text-xs text-red-600">
              Stops Docker, deletes all cloned files. Sure?
            </span>
            <button
              onClick={() => c.setConfirmRemove(false)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </>
        )}
        <button
          onClick={() => (c.confirmRemove ? void c.removeProject() : c.setConfirmRemove(true))}
          disabled={c.removing}
          className={`rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${
            c.confirmRemove
              ? 'bg-red-600 text-white hover:bg-red-500'
              : 'border border-red-200 text-red-600 hover:bg-red-50'
          }`}
        >
          {c.removing ? 'Removing…' : c.confirmRemove ? 'Yes, remove everything' : 'Remove project'}
        </button>
      </div>
      <h2 className="text-lg font-bold">{project.localPath.split('/').pop()}</h2>
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
          onClick={() => c.openExternal(c.appUrl)}
          className="font-mono text-brand hover:underline"
          title="Open in browser"
        >
          {c.appUrl}
        </button>
        <span
          className={`ml-2 inline-block h-2 w-2 rounded-full align-middle ${
            c.appHealthy ? 'bg-emerald-500' : 'bg-slate-300'
          }`}
          title={c.appHealthy ? 'App is responding' : 'App is not responding yet'}
        />
      </p>
    </header>
  );
}
