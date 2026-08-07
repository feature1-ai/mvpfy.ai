import { useEffect, useState } from 'react';
import { ProjectController } from '../hooks/useProjectController';
import { parsePorts } from '../lib/ports';

interface Props {
  c: ProjectController;
  mvpfyYml: string | null;
  onOpenTab: (tab: 'app' | 'code' | 'logs') => void;
}

type EnvState =
  | { kind: 'fresh' }
  | { kind: 'review' }
  | { kind: 'working'; label: string }
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'stopped' }
  | { kind: 'error' };

function envState(c: ProjectController): EnvState {
  if (c.busy) {
    const k = c.latestRun?.handle.kind;
    if (k === 'bootstrap') return { kind: 'working', label: 'Bootstrapping…' };
    if (k === 'docker-up') return { kind: 'working', label: 'Starting…' };
    if (k === 'docker-down') return { kind: 'working', label: 'Stopping…' };
  }
  switch (c.project.status) {
    case 'running':
      return c.appHealthy ? { kind: 'running' } : { kind: 'starting' };
    case 'needs-review':
      return { kind: 'review' };
    case 'stopped':
      return { kind: 'stopped' };
    case 'error':
      return { kind: 'error' };
    default:
      return c.hasMvpfyYml ? { kind: 'stopped' } : { kind: 'fresh' };
  }
}

export default function OverviewView({ c, mvpfyYml, onOpenTab }: Props) {
  const { project } = c;
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    void window.mvpfy.repoBranches(project.repos.map((r) => r.dir)).then(setBranches);
  }, [project.repos]);

  const env = envState(c);
  const ports = parsePorts(mvpfyYml);
  const cred = c.demoCredentials[0] ?? null;
  const name = project.localPath.split('/').pop();
  const homePath = project.localPath.replace(/^\/Users\/[^/]+/, '~');

  function copy(label: string, value: string) {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied((prev) => (prev === label ? null : prev)), 1500);
    });
  }

  const strip: Record<
    EnvState['kind'],
    { title: string; bodyText: string; green?: boolean; red?: boolean }
  > = {
    fresh: {
      title: 'Not bootstrapped yet',
      bodyText:
        'mvpfy will install dependencies and write the run config. Takes about two minutes the first time.',
    },
    review: {
      title: 'Review the generated files',
      bodyText: 'mvpfy wrote the run config below. Look it over — nothing runs until you start it.',
    },
    working: {
      title: env.kind === 'working' ? env.label : '',
      bodyText: 'This can take a couple of minutes. Watch the progress in Logs.',
    },
    starting: {
      title: 'Waiting for the app to respond…',
      bodyText: `The containers are up; waiting for localhost:${project.basePort} to answer.`,
    },
    running: {
      title: 'App is up',
      bodyText: 'The environment is running. Changes you make in the editor reload automatically.',
      green: true,
    },
    stopped: {
      title: 'Environment stopped',
      bodyText: `Everything is configured. Start it to bring the app back up on localhost:${project.basePort}.`,
    },
    error: {
      title: 'Something failed',
      bodyText: 'The last run did not finish. Check the logs, then retry.',
      red: true,
    },
  };
  const s = strip[env.kind];

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 pb-16 pt-7">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{name}</h1>
          <p className="mt-0.5 font-mono text-xs text-muted">{homePath}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => onOpenTab('app')} className="btn-secondary h-8 px-3.5">
            Open app
          </button>
          <button onClick={() => onOpenTab('code')} className="btn-secondary h-8 px-3.5">
            Open code
          </button>
        </div>
      </div>

      {c.actionError && (
        <div className="mb-5 rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
          {c.actionError}
        </div>
      )}

      <div className="grid items-start gap-5 min-[900px]:grid-cols-[minmax(0,1fr)_316px]">
        <div className="grid gap-5">
          {/* Environment card */}
          <section className="card overflow-hidden">
            <div
              className={`flex items-start gap-4 px-5 py-[18px] ${s.green ? 'bg-go-bg' : 'bg-surface'}`}
            >
              <span
                className={`mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full ${
                  s.green ? 'dot-pulse bg-go' : s.red ? 'bg-danger' : 'bg-dot-idle'
                }`}
              />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">{s.title}</h2>
                <p className="mt-0.5 text-[13px] leading-normal text-body">{s.bodyText}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {env.kind === 'running' && (
                  <>
                    <button
                      onClick={() => c.openExternal(c.appUrl)}
                      className="h-[34px] rounded-md bg-go px-3.5 text-[13px] font-medium text-white hover:bg-go-hover"
                    >
                      Open localhost:{project.basePort} ↗
                    </button>
                    <button
                      onClick={() => void c.docker('down')}
                      className="btn-secondary h-[34px] px-3.5"
                    >
                      Stop
                    </button>
                  </>
                )}
                {env.kind === 'fresh' && (
                  <button
                    onClick={() => void c.bootstrap()}
                    className="btn-primary h-[34px] px-3.5"
                  >
                    Bootstrap environment
                  </button>
                )}
                {env.kind === 'review' && (
                  <button
                    onClick={() => void c.docker('up')}
                    className="btn-primary h-[34px] px-3.5"
                  >
                    Reviewed — start environment
                  </button>
                )}
                {env.kind === 'stopped' && (
                  <button
                    onClick={() => void c.docker('up')}
                    disabled={!c.hasMvpfyYml}
                    className="btn-primary h-[34px] px-3.5 disabled:opacity-50"
                  >
                    Start environment
                  </button>
                )}
                {(env.kind === 'working' || env.kind === 'starting') && (
                  <button
                    onClick={() => onOpenTab('logs')}
                    className="btn-secondary h-[34px] px-3.5"
                  >
                    View logs
                  </button>
                )}
                {env.kind === 'error' && (
                  <>
                    <button
                      onClick={() => onOpenTab('logs')}
                      className="btn-secondary h-[34px] px-3.5"
                    >
                      View logs
                    </button>
                    <button
                      onClick={() => void c.bootstrap()}
                      className="btn-primary h-[34px] px-3.5"
                    >
                      Retry
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-6 border-t border-line px-5 py-3.5">
              <PortItem label="App" port={project.basePort} />
              {ports
                .filter((p) => p.port !== project.basePort)
                .slice(0, 3)
                .map((p) => (
                  <PortItem key={p.port} label={p.label} port={p.port} />
                ))}
              <button
                onClick={() => onOpenTab('logs')}
                className="ml-auto text-xs text-go hover:text-go-hover hover:underline"
              >
                View logs
              </button>
            </div>
          </section>

          {/* Generated files card */}
          <section className="card">
            <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
              <span className="section-label">Generated files</span>
              <span className="text-xs text-muted">written by mvpfy, safe to edit</span>
              <button
                onClick={c.refreshFiles}
                className="ml-auto text-xs text-go hover:text-go-hover hover:underline"
              >
                Refresh
              </button>
            </div>
            {c.viewerFiles.length === 0 ? (
              <p className="px-5 py-5 text-[13px] text-muted">
                Nothing yet — bootstrap the environment to generate the run config.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5 px-5 pt-3">
                  {c.viewerFiles.map((f) => (
                    <button
                      key={f.relativePath}
                      onClick={() => c.setActiveFile(f.relativePath)}
                      className={`h-7 rounded-md px-[11px] font-mono text-xs ${
                        c.activeFile === f.relativePath
                          ? 'bg-ink text-white'
                          : 'border border-line bg-surface text-body hover:bg-paper hover:text-ink'
                      }`}
                    >
                      {f.relativePath}
                    </button>
                  ))}
                </div>
                <pre className="mx-5 mb-5 mt-3 max-h-[260px] overflow-auto rounded-lg border border-line-subtle bg-sunken p-4 font-mono text-[12.5px] leading-[1.65] text-ink-hover">
                  {c.activeFileContent}
                </pre>
              </>
            )}
          </section>
          {/* Feature1 stories card */}
          <section className="card">
            <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
              <span className="section-label">Feature1 stories</span>
              {project.repos.length > 1 && (
                <select
                  value={c.targetRepoDir}
                  onChange={(e) => c.setTargetRepoDir(e.target.value)}
                  className="h-6 rounded border border-line bg-surface px-1 text-[11px] text-body"
                >
                  {project.repos.map((r) => (
                    <option key={r.dir} value={r.dir}>
                      implement in {r.dir.split('/').pop()}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => void c.refreshStories()}
                disabled={c.loadingStories}
                className="ml-auto text-xs text-go hover:text-go-hover hover:underline disabled:opacity-50"
              >
                {c.loadingStories ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            {c.storiesError && (
              <p className="px-5 pt-3 text-[13px] text-danger">{c.storiesError}</p>
            )}
            {c.stories.length === 0 && !c.storiesError ? (
              <p className="px-5 py-5 text-[13px] text-muted">
                {c.tenantConnected
                  ? 'Click refresh to load stories from Feature1.'
                  : 'Connect Feature1 in Settings to turn stories into pull requests.'}
              </p>
            ) : (
              <div className="divide-y divide-line-subtle px-5">
                {c.stories.map((story) => (
                  <div key={story.id} className="flex items-center gap-3 py-2.5">
                    <span className="font-mono text-xs text-muted">{story.code}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{story.title}</span>
                    <span className="rounded-full bg-paper px-2 py-0.5 text-[11px] text-muted">
                      {story.status}
                    </span>
                    <button
                      onClick={() => void c.implement(story)}
                      disabled={c.busy}
                      className="btn-primary h-7 px-3 text-xs disabled:opacity-50"
                    >
                      Implement
                    </button>
                  </div>
                ))}
              </div>
            )}
            {c.lastShipPrUrl && (
              <div className="mx-5 mb-4 mt-2 rounded-md border border-go-border bg-go-bgalt px-3 py-2 text-[13px]">
                Pull request ready:{' '}
                <button
                  onClick={() => c.openExternal(c.lastShipPrUrl!)}
                  className="font-medium text-go underline hover:text-go-hover"
                >
                  {c.lastShipPrUrl}
                </button>
              </div>
            )}
            {c.stories.length > 0 && <div className="pb-2" />}
          </section>
        </div>

        {/* Right column */}
        <div className="grid gap-5">
          <section className="card px-[18px] py-4">
            <div className="section-label mb-3">Repositories</div>
            <div className="grid gap-3">
              {project.repos.map((r) => (
                <div key={r.dir}>
                  <button
                    onClick={() => /^https?:/.test(r.url) && c.openExternal(r.url)}
                    className="text-[13px] font-medium text-ink hover:text-go"
                  >
                    {r.url.replace(/^https?:\/\/github\.com\//, '').replace(/^\/.*\//, '')}
                    {/^https?:/.test(r.url) && ' ↗'}
                  </button>
                  <p className="font-mono text-[11.5px] text-muted">
                    {r.dir.split('/').pop()}/{branches[r.dir] ? ` · ${branches[r.dir]}` : ''}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {cred && (
            <section className="card px-[18px] py-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="section-label">Demo login</span>
                <button
                  onClick={() =>
                    copy('all', cred.fields.map((f) => `${f.key}: ${f.value}`).join('\n'))
                  }
                  className="text-[11.5px] text-go hover:text-go-hover hover:underline"
                >
                  {copied === 'all' ? 'Copied' : 'Copy all'}
                </button>
              </div>
              <div className="grid gap-[9px]">
                {cred.fields.map((f) => (
                  <div key={f.key} className="flex items-center gap-2">
                    <span className="w-[62px] shrink-0 text-[11.5px] text-muted">{f.key}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                      {f.value}
                    </span>
                    <button
                      onClick={() => copy(f.key, f.value)}
                      className="h-[22px] shrink-0 rounded-[5px] border border-line bg-paper px-2 text-[11px] text-body hover:bg-hoverfill"
                    >
                      {copied === f.key ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="px-1">
            {confirmRemove ? (
              <div className="text-xs">
                <span className="text-body">
                  Stops Docker and deletes the local clone under ~/.mvpfy.{' '}
                </span>
                <button
                  onClick={() => void c.removeProject()}
                  disabled={c.removing}
                  className="font-medium text-danger hover:text-danger-hover disabled:opacity-50"
                >
                  {c.removing ? 'Removing…' : 'Remove everything'}
                </button>
                <span className="text-muted"> · </span>
                <button
                  onClick={() => setConfirmRemove(false)}
                  className="text-body hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmRemove(true)}
                className="text-xs text-danger hover:text-danger-hover"
              >
                Remove project…
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PortItem({ label, port }: { label: string; port: number }) {
  return (
    <div>
      <div className="section-label">{label}</div>
      <div className="font-mono text-[13px]">localhost:{port}</div>
    </div>
  );
}
