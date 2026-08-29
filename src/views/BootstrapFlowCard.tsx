import { ProjectController } from '../hooks/useProjectController';
import { ResolvedTask, RUNNING_TASK_ID, TASK_LANE_LABELS, TaskLane } from '../lib/bootstrapPlan';

interface Props {
  c: ProjectController;
}

const BADGE: Record<TaskLane, string> = {
  todo: 'bg-paper text-muted',
  doing: 'bg-paper text-body',
  check: 'bg-warn-bg text-warn-text',
  testing: 'bg-warn-bg text-warn-text',
  done: 'bg-go-bg text-go',
  blocked: 'bg-red-50 text-danger',
};

/** Why a card says what it says — the PM can hover any badge to find out. */
function badgeTitle(task: ResolvedTask): string {
  switch (task.lane) {
    case 'done':
      return task.verified
        ? `mvpfy confirmed this: ${task.files.join(', ')}`
        : 'Reported by the agent — there was no file for mvpfy to check';
    case 'check':
      return 'The agent said it did this, but mvpfy could not confirm it. Worth a look.';
    case 'testing':
      return 'Ready for you to try — only you can mark this done';
    case 'blocked':
      return 'The agent needs an answer from you before it can finish this';
    default:
      return '';
  }
}

/**
 * The bootstrap run as a board. The agent writes the tasks and may only claim
 * "working"; mvpfy marks a task done when it can see the files it promised;
 * the last card — the app actually up, with a working login — is the PM's.
 */
export default function BootstrapFlowCard({ c }: Props) {
  if (c.bootstrapTasks.length === 0) return null;
  const done = c.bootstrapTasks.filter((t) => t.lane === 'done').length;

  return (
    <section className="card">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="section-label">Setting up your app</span>
        <span className="font-mono text-[10.5px] text-faint">
          {done}/{c.bootstrapTasks.length} done
        </span>
        <span className="ml-auto text-xs text-muted">what mvpfy is doing, in plain language</span>
      </div>
      {c.bootstrapSummary && (
        <p className="border-b border-line-subtle px-5 py-3 text-[13px] leading-relaxed text-body">
          {c.bootstrapSummary}
        </p>
      )}
      <div className="divide-y divide-line-subtle px-5">
        {c.bootstrapTasks.map((task) => (
          <div key={task.id} className="flex items-start gap-3 py-3">
            <span
              className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${
                task.lane === 'doing'
                  ? 'dot-pulse bg-go'
                  : task.lane === 'done'
                    ? 'bg-go'
                    : task.lane === 'blocked'
                      ? 'bg-danger'
                      : task.lane === 'check' || task.lane === 'testing'
                        ? 'bg-warn-border'
                        : 'bg-dot-idle'
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{task.title}</p>
              {task.detail && (
                <p className="mt-0.5 text-[12.5px] leading-normal text-body">{task.detail}</p>
              )}
              {/* Everything the PM needs to actually do the testing, right on
                  the card that asks them to: the link and the login. */}
              {task.id === RUNNING_TASK_ID && task.lane === 'testing' && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <button
                    onClick={() => c.openExternal(c.appUrl)}
                    className="h-[30px] rounded-md bg-go px-3 text-xs font-medium text-white hover:bg-go-hover"
                  >
                    Open localhost:{c.project.basePort} ↗
                  </button>
                  {(c.demoCredentials[0]?.fields ?? []).map((f) => (
                    <span key={f.key} className="text-[12px] text-muted">
                      {f.key} <span className="font-mono text-ink">{f.value}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {task.id === RUNNING_TASK_ID && task.lane === 'testing' && (
              <button
                onClick={() => void c.acceptBootstrap()}
                className="btn-primary h-[30px] shrink-0 px-3 text-xs"
              >
                Yes — I can use it
              </button>
            )}
            {/* The setup is finished but nothing is up yet: starting it is the
                one action this card is waiting on. */}
            {task.id === RUNNING_TASK_ID && task.lane === 'todo' && c.hasMvpfyYml && (
              <button
                onClick={() => void c.docker('up')}
                disabled={c.busy}
                className="btn-primary h-[30px] shrink-0 px-3 text-xs disabled:opacity-50"
              >
                Start it
              </button>
            )}
            {task.id === RUNNING_TASK_ID && task.lane === 'done' && (
              <button
                onClick={() => void c.reopenBootstrap()}
                className="shrink-0 text-[11.5px] text-muted hover:text-ink"
              >
                Undo
              </button>
            )}
            <span
              title={badgeTitle(task)}
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${BADGE[task.lane]}`}
            >
              {TASK_LANE_LABELS[task.lane]}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
