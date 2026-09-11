import { useState } from 'react';
import { AgentKind } from '../../shared/types';
import { ProjectController } from '../hooks/useProjectController';
import { latestActivity } from '../lib/runActivity';
import LogPanel from '../components/LogPanel';

interface Props {
  c: ProjectController;
  agent: AgentKind;
}

const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * Ask the agent for something directly, in this project.
 *
 * Everything the board does goes through a flow — set up, plan, implement,
 * diagnose. This is the way round them: a change described in a sentence,
 * applied by the same agent, in the same workspace, tracked as a run like any
 * other so the log is kept and the files are re-read afterwards.
 *
 * For a real conversation there is the terminal, which is the agent's own
 * interface and needs nothing from us to be better than anything we would
 * build here.
 */
export default function AgentView({ c, agent }: Props) {
  const [draft, setDraft] = useState('');
  const running = c.busy && c.latestRun?.handle.kind === 'instruct';
  const activity = running ? latestActivity(c.latestRun?.log ?? '') : null;
  const label = AGENT_LABEL[agent];

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 pb-16 pt-7">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Ask {label}</h1>
          <p className="mt-0.5 text-[13px] text-body">
            Describe a change in plain language and {label} makes it here, in this project.
          </p>
        </div>
        <button
          onClick={() => void window.mvpfy.openTerminal(c.project.localPath)}
          title="Open your own terminal in this project, where you can run the agent yourself"
          className="btn-secondary h-8 shrink-0 px-3.5"
        >
          Open a terminal here ↗
        </button>
      </div>

      {c.actionError && (
        <div className="mb-5 rounded-lg border border-danger/30 bg-red-50 px-4 py-2.5 text-[13px] text-danger">
          {c.actionError}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          'e.g. The invoice list should show the customer’s company, not their email.\n' +
          'e.g. Turn off the welcome email while we are testing.'
        }
        rows={4}
        disabled={running}
        className="w-full resize-y rounded-lg border border-line bg-surface px-3.5 py-3 text-[13.5px] leading-relaxed outline-none placeholder:text-faint focus:border-muted disabled:opacity-60"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => {
            const text = draft;
            setDraft('');
            void c.instruct(text);
          }}
          disabled={running || c.planBlocked || !draft.trim()}
          className="btn-primary h-[38px] px-4 text-sm disabled:opacity-50"
        >
          {running ? 'Working…' : `Ask ${label}`}
        </button>
        <span className="text-xs text-muted">
          {running
            ? (activity ?? 'Reading the project…')
            : 'Runs on your agent subscription. It changes files — the report below says what.'}
        </span>
      </div>

      {/* What it did, in its own words, once it is finished. */}
      {c.changeContent && !c.busy && (
        <section className="card mt-6 overflow-hidden">
          <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
            <span className="section-label">What changed</span>
            <button
              onClick={() => void c.dismissChange()}
              className="ml-auto text-xs text-muted hover:text-body"
            >
              Dismiss
            </button>
          </div>
          <p className="whitespace-pre-wrap px-5 py-4 text-[13px] leading-relaxed text-body">
            {c.changeContent}
          </p>
        </section>
      )}

      {(running || c.latestRun?.handle.kind === 'instruct') && (
        <div className="mt-6">
          <div className="mb-2 section-label">Output</div>
          <LogPanel run={c.latestRun} onStop={c.stopRun} heightClass="h-[320px]" title="agent" />
        </div>
      )}
    </div>
  );
}
