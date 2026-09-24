import { useEffect, useState } from 'react';
import { ProjectController } from '../hooks/useProjectController';
import { parsePorts } from '../lib/ports';
import { latestActivity } from '../lib/runActivity';
import BootstrapFlowCard from './BootstrapFlowCard';
import QrCode from '../components/QrCode';
import EnvVarsCard from './EnvVarsCard';

interface Props {
  c: ProjectController;
  mvpfyYml: string | null;
  onOpenTab: (tab: 'plan' | 'agent' | 'app' | 'code' | 'logs') => void;
}

type EnvState =
  | { kind: 'fresh' }
  | { kind: 'review' }
  | { kind: 'working'; label: string }
  | { kind: 'starting' }
  | { kind: 'unresponsive' }
  | { kind: 'running' }
  | { kind: 'stopped' }
  | { kind: 'error' };

function envState(c: ProjectController): EnvState {
  if (c.busy) {
    const k = c.latestRun?.handle.kind;
    if (k === 'bootstrap-plan')
      return { kind: 'working', label: 'Working out what your app needs…' };
    if (k === 'bootstrap') return { kind: 'working', label: 'Setting your app up…' };
    // A start while the app is already known to be silent is the one automatic
    // retry, not a fresh attempt — saying so stops it looking spontaneous.
    if (k === 'docker-up') {
      return {
        kind: 'working',
        label: c.appUnresponsive ? 'The app did not answer — starting it again…' : 'Starting…',
      };
    }
    if (k === 'docker-down') return { kind: 'working', label: 'Stopping…' };
    if (k === 'seed') return { kind: 'working', label: 'Adding your demo login and sample data…' };
    if (k === 'triage') return { kind: 'working', label: 'Diagnosing & fixing…' };
    if (k === 'instruct') return { kind: 'working', label: 'Making your change…' };
    // Everything else — syncing, planning, implementing, raising a pull
    // request — leaves the containers alone. Reporting the environment as
    // "working" through those hid the running app's own controls and read as
    // the environment having gone down, which it had not.
  }
  switch (c.project.status) {
    // Between "Add project" and the bootstrap run actually starting.
    case 'queued':
      return { kind: 'working', label: 'Setting up the environment…' };
    case 'running':
      if (c.appHealthy) return { kind: 'running' };
      // Containers started and the app never answered. `up -d` exits zero once
      // they START, so nothing failed — which is why this needs saying.
      return c.appUnresponsive ? { kind: 'unresponsive' } : { kind: 'starting' };
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

/**
 * Starting the environment, and building it again from the files already here.
 *
 * One definition each, because there were two of each: the same action written
 * out per env state, which is how the two Rebuild buttons ended up carrying
 * different tooltips for the same click. Every other surface that wants to
 * start the app points at these rather than adding a third.
 */
function StartButton({ c, label }: { c: ProjectController; label: string }) {
  return (
    <button
      onClick={() => void c.docker('up')}
      disabled={!c.hasMvpfyYml}
      // Nothing can start without the generated run configuration, and a
      // button that is simply dim explains none of that.
      title={
        c.hasMvpfyYml
          ? 'Start the containers for this project'
          : 'This project has no mvpfy.yml yet — run setup first'
      }
      className="btn-primary h-[34px] px-3.5 disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function RebuildButton({ c, className = '' }: { c: ProjectController; className?: string }) {
  return (
    <button
      onClick={() => void c.docker('rebuild')}
      className={`btn-secondary h-[34px] px-3.5 ${className}`}
      title={
        c.canSeed
          ? 'Build the images again from the run configuration already here, recreate the containers, and seed. Your database and your code are left alone. For a stack whose images or containers were deleted.'
          : 'Build the images again from the run configuration already here and recreate the containers. This project records no seed command, so nothing is seeded — Re-run setup would add one.'
      }
    >
      {c.canSeed ? 'Rebuild & seed' : 'Rebuild'}
    </button>
  );
}

export default function OverviewView({ c, mvpfyYml, onOpenTab }: Props) {
  const { project } = c;
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [remotes, setRemotes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [forceArmed, setForceArmed] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);

  useEffect(() => {
    if (c.busy) return;
    void window.mvpfy.repoBranches(project.repos.map((r) => r.dir)).then(setBranches);
    // Asked of git rather than taken from the project record, which describes
    // the remote it was created with and not one added since.
    void window.mvpfy.repoRemotes(project.repos.map((r) => r.dir)).then(setRemotes);
  }, [project.repos, c.busy]);

  const env = envState(c);
  const stoppedNames = c.stoppedServices
    .map((sv) => `${sv.service}${sv.exitCode ? ` (exit ${sv.exitCode})` : ''}`)
    .join(', ');
  const testingFeature = project.testingSlug
    ? (c.plans.find((f) => f.slug === project.testingSlug)?.plan?.spec.feature ??
      project.testingSlug)
    : null;
  const activity = c.busy ? latestActivity(c.latestRun?.log ?? '') : null;
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
      // Setting a project up begins with a phase that writes the task list,
      // and until that file lands there are no cards to watch. The agent's
      // own last step is something true to show in the meantime.
      bodyText: activity ?? 'This can take a couple of minutes. Watch the progress in Logs.',
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
    unresponsive: {
      title: c.recoveryExhausted ? 'The app is still not responding' : 'The app is not responding',
      bodyText: c.recoveryExhausted
        ? `mvpfy restarted it three times and asked ${
            stoppedNames ? `about ${stoppedNames}` : 'the agent to look'
          }, and it is still silent. Nothing else it can try on its own will change that — the logs below are the next place to look.`
        : stoppedNames
          ? `${stoppedNames} stopped instead of staying up, so nothing is listening on localhost:${project.basePort}.`
          : `Everything started, but nothing has answered on localhost:${project.basePort}. The app may be failing as it boots.`,
      red: true,
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

      {/* Deterministic and worth saying loudly: the app may be running
          perfectly somewhere mvpfy is not looking, which otherwise reads as
          an app that never started. */}
      {c.portMismatch && (
        <div className="mb-5 rounded-lg border border-warn-border bg-warn-bg px-4 py-3 text-[13px] text-warn-text">
          <strong className="font-medium">Your app is published on a different port.</strong> The
          run configuration publishes{' '}
          <span className="font-mono">localhost:{c.portMismatch.publishing}</span>, but mvpfy is
          watching <span className="font-mono">localhost:{c.portMismatch.watching}</span> because
          that is what mvpfy.yml records. Your app may be running fine at the first one. Rebuild
          &amp; seed puts them back in step, or change <span className="font-mono">host_port</span>{' '}
          in mvpfy.yml to {c.portMismatch.publishing}.
        </div>
      )}

      {c.actionError && (
        <div className="mb-5 rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
          {c.actionError}
        </div>
      )}

      <div className="grid items-start gap-5 min-[900px]:grid-cols-[minmax(0,1fr)_316px]">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Environment card */}
          <section className="card overflow-hidden">
            {/* Wraps rather than squeezes. The running state carries five
                controls, and against a text column that may shrink they took
                the width and left the status crushed into a column a few words
                wide. Below the basis the buttons drop to their own line. */}
            <div
              className={`flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-[18px] ${s.green ? 'bg-go-bg' : 'bg-surface'}`}
            >
              <span
                className={`mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full ${
                  s.green ? 'dot-pulse bg-go' : s.red ? 'bg-danger' : 'bg-dot-idle'
                }`}
              />
              <div className="min-w-0 flex-1 basis-[280px]">
                <h2 className="text-[15px] font-semibold">{s.title}</h2>
                <p className="mt-0.5 text-[13px] leading-normal text-body">{s.bodyText}</p>
                {/* Which code is running is not a detail: accepting a story
                    against another feature's build is the mistake this
                    prevents. */}
                {testingFeature && (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-go-bg px-2 py-0.5 text-[11.5px] text-go">
                    <span className="h-1.5 w-1.5 rounded-full bg-go" />
                    Running the feature “{testingFeature}”
                  </p>
                )}
              </div>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                {/* The containers are up in both states — the app answering
                    is the only difference — so the controls that act on them
                    belong in both. Waiting for an app that never answers is
                    exactly when someone needs a way out. */}
                {(env.kind === 'running' ||
                  env.kind === 'starting' ||
                  env.kind === 'unresponsive') && (
                  <>
                    {env.kind === 'running' && (
                      <button
                        onClick={() => c.openExternal(c.appUrl)}
                        className="h-[34px] rounded-md bg-go px-3.5 text-[13px] font-medium text-white hover:bg-go-hover"
                      >
                        Open localhost:{project.basePort} ↗
                      </button>
                    )}
                    <button
                      onClick={() => void c.docker('restart')}
                      className="btn-secondary h-[34px] px-3.5"
                      title="Stop and start the environment — applies env and config changes"
                    >
                      Restart
                    </button>
                    <RebuildButton c={c} />
                    <button
                      onClick={() => void c.docker('down')}
                      className="btn-secondary h-[34px] px-3.5"
                    >
                      Stop
                    </button>
                    {/* Second click only: Stop waits out each container's
                        shutdown, which is the right default. Force is for the
                        one that never comes back, and it should be a decision
                        rather than the button next to the one you meant. */}
                    <button
                      onClick={() => {
                        if (forceArmed) {
                          setForceArmed(false);
                          void c.docker('force-down');
                        } else {
                          setForceArmed(true);
                        }
                      }}
                      onBlur={() => setForceArmed(false)}
                      title="Kill the containers immediately, without waiting for them to shut down cleanly"
                      className={`h-[34px] rounded-md px-3 text-[13px] ${
                        forceArmed
                          ? 'bg-danger font-medium text-white'
                          : 'text-muted hover:text-danger'
                      }`}
                    >
                      {forceArmed ? 'Force stop — confirm' : 'Force stop'}
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
                  <StartButton c={c} label="Reviewed — start environment" />
                )}
                {env.kind === 'stopped' && <RebuildButton c={c} className="mr-2" />}
                {env.kind === 'stopped' && <StartButton c={c} label="Start environment" />}
                {(env.kind === 'working' || env.kind === 'starting') && (
                  <button
                    onClick={() => onOpenTab('logs')}
                    className="btn-secondary h-[34px] px-3.5"
                  >
                    View logs
                  </button>
                )}
                {(env.kind === 'error' || env.kind === 'unresponsive') && (
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

          {/* Only while it is up: sharing an app that is not running shares a
              connection refused, which is worse than not offering it. */}
          {env.kind === 'running' && <ShareApp c={c} />}

          {/* A mobile preview was being read out of mvpfy.yml and shown
              nowhere. Its own note says to scan a QR, and there was none. */}
          <MobileApp c={c} />

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
              {/* Lives with the files it rewrites, not among the run controls:
                  it is about how this project was set up, not about starting
                  and stopping it. */}
              <button
                onClick={() => {
                  if (confirmRerun) {
                    setConfirmRerun(false);
                    void c.rebootstrap();
                  } else {
                    setConfirmRerun(true);
                  }
                }}
                onBlur={() => setConfirmRerun(false)}
                disabled={c.busy}
                title="Write this project's run configuration again, as the current version of mvpfy would. Your database and your code are left alone."
                className={`ml-auto text-xs disabled:opacity-50 ${
                  confirmRerun ? 'font-medium text-danger' : 'text-muted hover:text-body'
                }`}
              >
                {confirmRerun ? 'Re-run setup — confirm' : 'Re-run setup'}
              </button>
              <button
                onClick={c.refresh}
                className="text-xs text-go hover:text-go-hover hover:underline"
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
            {/* Launch readiness is a feature like the others — mvpfy starts it
                with the project, so it is usually the first one here. */}
            {(c.readinessVerdict || c.readinessRunning) && (
              <button
                onClick={() => onOpenTab('plan')}
                className="flex w-full items-center gap-2 border-b border-line-subtle px-5 py-3 text-left hover:bg-hoverfill"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    c.readinessRunning
                      ? 'dot-pulse bg-go'
                      : c.readinessVerdict?.kind === 'not-ready'
                        ? 'bg-danger'
                        : c.readinessVerdict?.kind === 'your-call'
                          ? 'bg-warn-border'
                          : 'bg-go'
                  }`}
                />
                <span className="text-[13px] font-medium">Launch readiness</span>
                <span className="text-[12.5px] text-muted">
                  {c.readinessRunning
                    ? 'checking what is left before launch…'
                    : (c.readinessVerdict?.title ?? '')}
                </span>
              </button>
            )}
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
              {project.repos.map((r) => {
                const remote = remotes[r.dir] ?? r.url;
                return (
                  <div key={r.dir}>
                    {remote ? (
                      <button
                        onClick={() => /^https?:/.test(remote) && c.openExternal(remote)}
                        className="text-[13px] font-medium text-ink hover:text-go"
                      >
                        {remote.replace(/^https?:\/\/github\.com\//, '').replace(/^\/.*\//, '')}
                        {/^https?:/.test(remote) && ' ↗'}
                      </button>
                    ) : (
                      <span className="text-[13px] font-medium text-muted">No remote yet</span>
                    )}
                    <p className="font-mono text-[11.5px] text-muted">
                      {r.dir.split('/').pop()}/{branches[r.dir] ? ` · ${branches[r.dir]}` : ''}
                    </p>
                    {!remote && <AddRemote c={c} dir={r.dir} />}
                  </div>
                );
              })}
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

/**
 * Give a repository somewhere to push, after the fact.
 *
 * A project can be started with no remote, and everything but raising a pull
 * request works without one — which is only a real choice if there is a way to
 * change your mind later. This is that way.
 */
function AddRemote({ c, dir }: { c: ProjectController; dir: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-1 text-[11.5px] text-go hover:underline">
        Add a remote
      </button>
    );
  }
  const send = () => {
    if (!url.trim() || c.busy) return;
    void c.addRemote(dir, url).then((ok) => {
      if (ok) {
        setUrl('');
        setOpen(false);
      }
    });
  };
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="https://github.com/acme/app.git"
        disabled={c.busy}
        spellCheck={false}
        autoFocus
        className="h-[30px] w-full rounded-md border border-line bg-surface px-2.5 font-mono text-[11.5px] outline-none placeholder:text-faint focus:border-muted"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={send}
          disabled={c.busy || !url.trim()}
          className="btn-primary h-[26px] px-2.5 text-[11.5px] disabled:opacity-50"
        >
          Add and push
        </button>
        <button onClick={() => setOpen(false)} className="text-[11.5px] text-muted hover:text-body">
          Cancel
        </button>
      </div>
      <p className="text-[11px] leading-snug text-faint">
        Pushes what is here, so you find out now if it is the wrong address or a repository that
        already has something in it.
      </p>
    </div>
  );
}

/**
 * Putting the running app on the internet for as long as somebody needs to
 * look at it.
 *
 * The thing a product manager wants after building something is to show it to
 * a person who is not sitting next to them, and the alternative to this is
 * deploying — which is the whole afternoon this app exists to avoid.
 *
 * What it says before it does it matters as much as what it does. This is a
 * half-built product with its demo login printed on the screen beside the
 * link, and anybody holding that link can use it. The address is unguessable
 * and nothing indexes it, which is not the same as private, and the difference
 * is worth one sentence rather than a footnote nobody reads.
 */
function ShareApp({ c }: { c: ProjectController }) {
  const [copied, setCopied] = useState(false);
  const [showHost, setShowHost] = useState(Boolean(c.shareHostHeader));
  if (!c.canShare) {
    return (
      <section className="card flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <p className="text-[13px] text-body">
          <span className="font-medium text-ink">Show this to someone else.</span> Needs Cloudflare
          Tunnel, which mvpfy can install from Settings — no account, no signup.
        </p>
      </section>
    );
  }
  if (c.shareRefused) {
    return (
      <section className="card flex flex-wrap items-center justify-between gap-3 border-warn-border px-5 py-3.5">
        <p className="max-w-[560px] text-[13px] text-warn-text">
          Cloudflare would not give out a link just now — the free tunnels are rate limited and it
          refused this one. Nothing is wrong at your end; stop and try again in a few minutes.
        </p>
        <button onClick={() => c.stopShare()} className="btn-secondary h-8 shrink-0 px-3.5">
          Stop
        </button>
      </section>
    );
  }
  if (c.shareUrl) {
    return (
      <section className="card border-go/30 px-5 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* The address is four random words and a domain — nobody is typing
              that into a phone. */}
          <QrCode value={c.shareUrl} label="Scan to open on a phone" />
          <div className="min-w-0 flex-1">
            <span className="section-label text-go">
              Shared — anyone with this link can open it
            </span>
            <button
              onClick={() => c.openExternal(c.shareUrl!)}
              className="mt-1 block max-w-full truncate font-mono text-[12.5px] text-go hover:underline"
            >
              {c.shareUrl.replace('https://', '')}
            </button>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(c.shareUrl!);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className="btn-secondary h-8 px-3.5"
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button
              onClick={() => c.stopShare()}
              className="h-8 rounded-md px-3 text-[13px] text-muted hover:text-danger"
            >
              Stop sharing
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11.5px] text-muted">
          The link works while mvpfy is open and stops the moment you stop sharing. Your demo login
          works on it too, so send it to people you would give that login to.
        </p>
      </section>
    );
  }
  return (
    <section className="card px-5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[520px] text-[13px] text-body">
          <span className="font-medium text-ink">Show this to someone else.</span> Puts the running
          app on a temporary public address so anyone you send it to can try it — no deploying. It
          lasts until you stop it, and anybody with the link can use it, demo login included.
        </p>
        <button
          onClick={() => void c.startShare()}
          disabled={c.busy || c.shareStarting}
          className="btn-secondary h-8 shrink-0 px-3.5 disabled:opacity-50"
        >
          {c.shareStarting ? 'Getting a link…' : 'Share'}
        </button>
      </div>
      {/* Only for products that work out who they are serving from the
          hostname. For everything else it is a question nobody needs, so it
          stays folded away rather than sitting in the way. */}
      <button
        onClick={() => setShowHost((v) => !v)}
        className="mt-2 text-[11.5px] text-muted hover:text-body"
      >
        {showHost ? 'Hide' : 'Does your app pick a tenant from the address?'}
      </button>
      {showHost && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={c.shareHostHeader}
              onChange={(e) => c.setShareHostHeader(e.target.value)}
              placeholder="acme.localhost:4100"
              spellCheck={false}
              className="h-[30px] min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 font-mono text-[11.5px] outline-none placeholder:text-faint focus:border-muted"
            />
          </div>
          <p className="text-[11px] leading-snug text-muted">
            A shared link arrives as four random words, which matches no tenant, so the app shows
            the visitor nothing. This is the address it will be told it was asked for — taken from
            your demo login when that names a tenant, and yours to change. It does not fix an app
            that redirects the visitor to its own local address; that has to be the app&apos;s
            doing.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * The app on an actual phone, when the product is one.
 *
 * mvpfy.yml can carry an Expo URL, and it has been parsed since before this
 * was written — it just had nowhere to appear, which is the same as not being
 * read at all. Its own note tells the product manager to scan a QR code.
 */
function MobileApp({ c }: { c: ProjectController }) {
  const m = c.mobilePreview;
  if (!m || (!m.expoUrl && !m.note)) return null;
  return (
    <section className="card flex flex-wrap items-center gap-4 px-5 py-3.5">
      {m.expoUrl && <QrCode value={m.expoUrl} label="Scan in Expo Go" />}
      <div className="min-w-0 flex-1">
        <span className="section-label">On your phone</span>
        {m.note && <p className="mt-1 text-[13px] text-body">{m.note}</p>}
        {m.expoUrl && (
          <p className="mt-1 break-all font-mono text-[11.5px] text-muted">{m.expoUrl}</p>
        )}
        {m.kind && <p className="mt-1 text-[11px] text-faint">{m.kind}</p>}
      </div>
    </section>
  );
}
