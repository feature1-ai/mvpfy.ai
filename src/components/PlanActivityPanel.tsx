import { useId, useState } from 'react';
import type { RunState } from '../lib/useRuns';
import LogPanel from './LogPanel';

interface Props {
  runs: RunState[];
  onStop: (runId: string) => void;
}

/** A project-wide dock: stays available while moving between feature boards. */
export default function PlanActivityPanel({ runs, onStop }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [pickedRunId, setPickedRunId] = useState('');
  const panelId = useId();
  const storyRuns = runs.filter(
    (run) =>
      run.handle.kind === 'plan-story' ||
      run.handle.kind === 'migrate' ||
      (run.handle.kind === 'docker-up' && run.handle.planSlug !== undefined)
  );
  const running = storyRuns.filter((run) => run.running);
  const picked = storyRuns.find((run) => run.handle.runId === pickedRunId);
  const shown = picked ?? running[running.length - 1] ?? storyRuns[storyRuns.length - 1];

  if (!shown) return null;

  return (
    <section
      aria-label="Implementation activity"
      className="shrink-0 border-t border-line bg-surface shadow-[0_-4px_16px_-12px_rgba(27,26,23,0.2)]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-12 w-full items-center gap-3 px-6 py-3 text-left text-[13px] hover:bg-paper"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${running.length ? 'dot-pulse bg-go' : 'bg-dot-idle'}`}
        />
        <span className="font-medium">Implementation logs</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {running.length
            ? `${running.length} ${running.length === 1 ? 'task' : 'tasks'} running`
            : 'Recent feature runs'}
        </span>
        <span className="shrink-0 text-xs text-brand">
          {expanded ? 'Hide logs ↓' : 'Show logs ↑'}
        </span>
      </button>
      <div id={panelId} hidden={!expanded} className="px-4 pb-4 sm:px-6">
        {expanded && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor={`${panelId}-run`} className="text-xs text-muted">
                Story run
              </label>
              <select
                id={`${panelId}-run`}
                value={picked ? pickedRunId : ''}
                onChange={(event) => setPickedRunId(event.target.value)}
                className="h-8 min-w-0 max-w-full flex-1 rounded-md border border-line bg-surface px-2 text-xs text-body sm:flex-none sm:max-w-[560px]"
              >
                <option value="">Follow latest implementation</option>
                {[...storyRuns].reverse().map((run) => (
                  <option key={run.handle.runId} value={run.handle.runId}>
                    {runLabel(run)}
                    {run.startedAt ? ` · ${new Date(run.startedAt).toLocaleString()}` : ''}
                    {' · '}
                    {run.running
                      ? 'Running'
                      : run.exitCode === 0
                        ? 'Completed'
                        : 'Failed or stopped'}
                  </option>
                ))}
              </select>
            </div>
            <LogPanel
              run={shown}
              onStop={onStop}
              title={
                shown.handle.kind === 'migrate'
                  ? 'Database migrations'
                  : shown.handle.kind === 'docker-up'
                    ? 'Restarting preview'
                    : shown.handle.planSlug || 'Implementation'
              }
              heightClass="h-[32vh] min-h-[180px] max-h-[360px]"
            />
          </>
        )}
      </div>
    </section>
  );
}

function runLabel(run: RunState): string {
  return [
    run.handle.planSlug || 'Feature',
    run.handle.storyId ||
      (run.handle.kind === 'migrate' ? 'Database migrations' : 'Restart preview'),
  ].join(' · ');
}
