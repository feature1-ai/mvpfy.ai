import { useEffect, useState } from 'react';
import { ProjectController } from '../hooks/useProjectController';
import { parsePorts } from '../lib/ports';
import BootstrapFlowCard from './BootstrapFlowCard';
import EnvVarsCard from './EnvVarsCard';

interface Props {
  c: ProjectController;
  mvpfyYml: string | null;
  onOpenTab: (tab: 'plan' | 'app' | 'code' | 'logs') => void;
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
    if (k === 'bootstrap-plan')
      return { kind: 'working', label: 'Working out what your app needs…' };
    if (k === 'bootstrap') return { kind: 'working', label: 'Setting your app up…' };
    if (k === 'docker-up') return { kind: 'working', label: 'Starting…' };
    if (k === 'docker-down') return { kind: 'working', label: 'Stopping…' };
    if (k === 'triage') return { kind: 'working', label: 'Diagnosing & fixing…' };
    if (k === 'instruct') return { kind: 'working', label: 'Making your change…' };
    if (k === 'sync') return { kind: 'working', label: 'Syncing repositories…' };
    if (k === 'readiness') return { kind: 'working', label: 'Checking launch readiness…' };
    if (k === 'plan-spec') return { kind: 'working', label: 'Writing the product spec…' };
    if (k === 'plan-story') return { kind: 'working', label: 'Implementing a story…' };
    if (k === 'ship') return { kind: 'working', label: 'Shipping as a pull request…' };
  }
  switch (c.project.status) {
    // Between "Add project" and the bootstrap run actually starting.
    case 'queued':
      return { kind: 'working', label: 'Setting up the environment…' };
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
    if (c.busy) return;
    void window.mvpfy.repoBranches(project.repos.map((r) => r.dir)).then(setBranches);
  }, [project.repos, c.busy]);

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
        'mvpfy will install dependencies and write the run config. Takes about two minutes the first time and runs on your agent subscription.',
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
      bodyText:
        'The last run did not finish. mvpfy can look at what happened, explain it in plain language, and fix it.',
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
        <div className="flex min-w-0 flex-col gap-5">
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
                      onClick={() => void c.docker('restart')}
                      className="btn-secondary h-[34px] px-3.5"
                      title="Stop and start the environment — applies env and config changes"
                    >
                      Restart
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
                      onClick={() => void c.diagnose()}
                      className="btn-primary h-[34px] px-3.5"
                    >
                      Diagnose & fix
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

          {/* Setup board — the bootstrap run as cards the PM can follow */}
          <BootstrapFlowCard c={c} />

          {/* Change report — result of an Ask-mvpfy instruction */}
          {c.changeContent && !c.busy && (
            <section className="card border-go-border">
              <div className="flex items-start gap-3 px-5 py-4">
                <span className="mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full bg-go" />
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold">Done — here's what changed</h2>
                  <div className="mt-1 grid gap-1 text-[13px] leading-normal text-body">
                    {c.changeContent
                      .split('\n')
                      .filter((l) => l.trim() && !/^restart:/i.test(l.trim()))
                      .slice(0, 4)
                      .map((l, i) => (
                        <p key={i}>{l.replace(/^[-*]\s*/, '')}</p>
                      ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => void c.dismissChange()}
                    className="btn-secondary h-[34px] px-3.5"
                  >
                    Dismiss
                  </button>
                  {!/^\s*PR:/m.test(c.changeContent) && (
                    <button
                      onClick={() => void c.shipChange()}
                      className="btn-secondary h-[34px] px-3.5"
                      title="Commit the change on a branch and open a pull request for your team to review"
                    >
                      Ship as PR
                    </button>
                  )}
                  {c.changeNeedsRestart && (
                    <button
                      onClick={() => {
                        void c.dismissChange();
                        void c.docker('restart');
                      }}
                      className="btn-primary h-[34px] px-3.5"
                    >
                      Restart to apply
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Triage result — plain-language diagnosis after Diagnose & fix */}
          {c.triageContent && !c.busy && (
            <section className="card border-go-border">
              <div className="flex items-start gap-3 px-5 py-4">
                <span className="mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full bg-go" />
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold">mvpfy found and fixed the problem</h2>
                  <div className="mt-1 grid gap-1 text-[13px] leading-normal text-body">
                    {c.triageContent
                      .split('\n')
                      .filter((l) => l.trim() && !/^retry:/i.test(l.trim()))
                      .slice(0, 4)
                      .map((l, i) => (
                        <p key={i}>{l.replace(/^[-*]\s*/, '')}</p>
                      ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => void c.dismissTriage()}
                    className="btn-secondary h-[34px] px-3.5"
                  >
                    Dismiss
                  </button>
                  <button onClick={() => void c.retryFix()} className="btn-primary h-[34px] px-3.5">
                    Retry now
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Plain-language bootstrap summary. Not tied to the review state:
              setup starts the app itself now, so 'needs-review' is a moment
              the PM may never see. */}
          {c.summaryContent && !c.busy && (
            <section className="card">
              <div className="border-b border-line px-5 py-3.5">
                <span className="section-label">What mvpfy set up</span>
              </div>
              <p className="whitespace-pre-wrap px-5 py-4 text-[13px] leading-relaxed text-body [text-wrap:pretty]">
                {c.summaryContent}
              </p>
            </section>
          )}

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
          {/* Planned work — summary of the Plan boards, one per feature */}
          <section className="card">
            <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
              <span className="section-label">Planned work</span>
              {c.plans.length > 0 && (
                <span className="text-[11px] text-faint">
                  {c.plans.length} feature{c.plans.length === 1 ? '' : 's'}
                </span>
              )}
              <button
                onClick={() => onOpenTab('plan')}
                className="ml-auto text-xs text-go hover:text-go-hover hover:underline"
              >
                {c.plans.length > 0 ? 'Open board' : 'Plan a feature'}
              </button>
            </div>
            {c.plans.length === 0 ? (
              <p className="px-5 py-5 text-[13px] text-muted">
                Nothing planned yet. Describe a feature in the Plan tab and mvpfy writes the spec,
                breaks it into stories, and runs them one by one.
              </p>
            ) : (
              c.plans.map((feature) => (
                <div
                  key={feature.slug}
                  className="border-b border-line-subtle pb-2 last:border-b-0"
                >
                  <p className="flex items-center gap-2 px-5 pt-3 text-[13px] font-medium">
                    {(feature.generating || feature.runningStory) && (
                      <span className="dot-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-go" />
                    )}
                    {feature.plan?.spec.feature ?? feature.slug}
                    {feature.plan && (
                      <span className="font-mono text-[10.5px] font-normal text-faint">
                        {feature.plan.stories.filter((s) => s.lane === 'done').length}/
                        {feature.plan.stories.length} done
                      </span>
                    )}
                  </p>
                  {feature.generating && !feature.plan ? (
                    <p className="px-5 py-2 text-[12.5px] text-muted">Writing the spec…</p>
                  ) : feature.plan && !feature.plan.approved ? (
                    <p className="px-5 py-2 text-[12.5px] text-muted">
                      PRD ready — review and agree in the Plan tab to open its board.
                    </p>
                  ) : (
                    <div className="divide-y divide-line-subtle px-5">
                      {(feature.plan?.stories ?? []).map((story) => (
                        <div key={story.code} className="flex items-center gap-3 py-2.5">
                          <span className="font-mono text-xs text-muted">{story.code}</span>
                          <span className="min-w-0 flex-1 truncate text-[13px]">{story.title}</span>
                          {story.prUrl && (
                            <button
                              onClick={() => c.openExternal(story.prUrl!)}
                              className="font-mono text-[10.5px] text-go hover:underline"
                            >
                              PR ↗
                            </button>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] ${
                              story.lane === 'done'
                                ? 'bg-go-bg text-go'
                                : story.lane === 'testing'
                                  ? 'bg-warn-bg text-warn-text'
                                  : story.lane === 'coding'
                                    ? 'bg-paper text-body'
                                    : 'bg-paper text-muted'
                            }`}
                          >
                            {story.lane === 'todo' ? 'to do' : story.lane}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </section>
        </div>

        {/* Right column */}
        <div className="flex min-w-0 flex-col gap-5">
          <section className="card px-[18px] py-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="section-label">Repositories</span>
              <button
                onClick={() => void c.syncRepos()}
                disabled={c.busy}
                className="text-[11.5px] text-go hover:text-go-hover hover:underline disabled:opacity-50"
                title="Pull the latest changes from each repo's remote"
              >
                Sync
              </button>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
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
              <div className="flex min-w-0 flex-col gap-[9px]">
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

          <EnvVarsCard c={c} />

          <div className="px-1">
            {confirmRemove ? (
              <div className="text-xs">
                <span className="text-body">
                  {project.mode === 'linked'
                    ? 'Stops Docker and removes the .mvpfy/ subfolder — your code stays untouched. '
                    : 'Stops Docker and deletes the local clone under ~/.mvpfy. '}
                </span>
                <button
                  onClick={() => void c.removeProject()}
                  disabled={c.removing}
                  className="font-medium text-danger hover:text-danger-hover disabled:opacity-50"
                >
                  {c.removing
                    ? 'Removing…'
                    : project.mode === 'linked'
                      ? 'Remove from mvpfy'
                      : 'Remove everything'}
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
