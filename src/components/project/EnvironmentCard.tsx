import { ProjectController } from '../../hooks/useProjectController';
import DemoCredentialsCard from './DemoCredentialsCard';
import MobilePreviewCard from './MobilePreviewCard';

export default function EnvironmentCard({ c }: { c: ProjectController }) {
  const { project } = c;
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Environment
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void c.bootstrap()}
          disabled={c.busy}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
        >
          Bootstrap environment
        </button>
        <button
          onClick={() => void c.docker('up')}
          disabled={c.busy || !c.hasMvpfyYml}
          title={
            c.hasMvpfyYml
              ? 'Runs docker compose -f docker-compose.mvpfy.yml up -d'
              : 'Bootstrap first, then review the generated files'
          }
          className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {project.status === 'needs-review' ? 'Reviewed — start environment' : 'Start environment'}
        </button>
        <button
          onClick={() => void c.docker('down')}
          disabled={c.busy || project.status !== 'running'}
          className="rounded-md bg-slate-600 px-3 py-2 text-sm font-medium text-white hover:bg-slate-500 disabled:opacity-50"
        >
          Stop environment
        </button>
        {project.status === 'running' &&
          (c.appHealthy ? (
            <button
              onClick={() => c.openExternal(c.appUrl)}
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
          Review the generated files below before starting the environment. Nothing runs until you
          click start.
        </p>
      )}
      <MobilePreviewCard preview={c.mobilePreview} />
      <DemoCredentialsCard credentials={c.demoCredentials} onOpenExternal={c.openExternal} />
    </section>
  );
}
