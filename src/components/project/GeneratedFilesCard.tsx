import { ProjectController } from '../../hooks/useProjectController';

export default function GeneratedFilesCard({ c }: { c: ProjectController }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Generated files
        </h3>
        <button onClick={c.refreshFiles} className="text-xs font-medium text-brand hover:underline">
          Refresh
        </button>
      </div>
      {c.viewerFiles.length === 0 ? (
        <p className="text-sm text-slate-400">
          No generated files yet. Run “Bootstrap environment” to create them.
        </p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1">
            {c.viewerFiles.map((f) => (
              <button
                key={f.relativePath}
                onClick={() => c.setActiveFile(f.relativePath)}
                className={`rounded-md px-2 py-1 text-xs font-medium ${
                  c.activeFile === f.relativePath
                    ? 'bg-brand-dark text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {f.relativePath}
              </button>
            ))}
          </div>
          <pre className="max-h-64 overflow-auto rounded-md bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">
            {c.activeFileContent}
          </pre>
        </>
      )}
    </section>
  );
}
