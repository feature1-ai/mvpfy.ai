import { useEffect, useRef, useState } from 'react';
import type { AgentKind, ChatTurn, Conversation } from '../../shared/types';
import { ProjectController } from '../hooks/useProjectController';
import { replySoFar } from '../lib/chat';
import { COMPONENT_LABELS } from '../lib/components';
import { latestActivity } from '../lib/runActivity';

const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

interface Props {
  c: ProjectController;
  onOpenOverview: () => void;
}

/**
 * The running app, and the conversations that change it.
 *
 * The preview is the point, so it takes the room; the conversations sit
 * beside it in a rail, because a change asked for in words is only finished
 * when it is seen. Each part of the product — a customer portal, an admin —
 * has its own conversations and its own runner, chosen from the dropdown.
 */
export default function AppView({ c, onOpenOverview }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webview = useRef<any>(null);
  const app = c.selectedApp;
  const local = app.url?.startsWith('http://localhost') ?? false;
  const live = app.url
    ? app.url === c.appUrl
      ? c.appHealthy
      : !local || c.project.status === 'running'
    : false;

  // A change landed in this part: show it. Live reload usually has already,
  // but a restart or a server-rendered page will not have, and a preview that
  // still shows the old thing reads as the change not having worked.
  const changedAt = c.appChangedAt[app.id] ?? 0;
  useEffect(() => {
    if (changedAt) webview.current?.reload?.();
  }, [changedAt]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line bg-surface px-4 py-2">
        <label className="sr-only" htmlFor="app-target">
          Part of the product
        </label>
        <select
          id="app-target"
          value={app.id}
          onChange={(e) => c.selectApp(e.target.value)}
          className="h-8 rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium focus:border-muted"
        >
          {c.appTargets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.kind !== 'project' ? ` · ${COMPONENT_LABELS[t.kind] ?? t.kind}` : ''}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="app-agent">
          Agent for this part
        </label>
        <select
          id="app-agent"
          value={c.agentForApp(app.id)}
          onChange={(e) => c.setAppAgent(app.id, e.target.value as AgentKind)}
          title="Which agent new conversations about this part talk to. A conversation keeps the agent it started with."
          className="h-8 rounded-md border border-line bg-surface px-2.5 text-[13px] text-body focus:border-muted"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <div className="ml-auto flex items-center gap-3.5 text-xs">
          {app.url && live && (
            <>
              <span className="flex h-7 items-center gap-1.5 rounded-md border border-go-border bg-go-bgalt px-[11px] font-mono text-xs text-go">
                <span className="h-1.5 w-1.5 rounded-full bg-go" />
                {app.url.replace(/^https?:\/\//, '')}
              </span>
              <button
                onClick={() => webview.current?.reloadIgnoringCache?.()}
                className="text-go hover:text-go-hover hover:underline"
                title="Force refresh — reloads the app ignoring cached files"
              >
                Refresh
              </button>
              <button
                onClick={() => app.url && c.openExternal(app.url)}
                className="text-go hover:text-go-hover hover:underline"
              >
                Open in browser ↗
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <ChatRail c={c} />
        <div className="min-w-0 flex-1 p-3">
          {app.url && live ? (
            <div className="h-full overflow-hidden rounded-[10px] border border-line bg-surface">
              <webview
                ref={webview}
                src={app.url}
                partition="persist:mvpfy-embedded"
                style={{ display: 'flex', width: '100%', height: '100%' }}
              />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <h2 className="text-[15px] font-semibold">
                {!app.url
                  ? `${app.name} has no page to show here`
                  : c.project.status === 'running'
                    ? 'Waiting for the app…'
                    : 'The app is not running'}
              </h2>
              <p className="mt-1 max-w-[420px] text-[13px] leading-normal text-body">
                {!app.url
                  ? 'It runs as an app on a device rather than a page. You can still change it here — start it on a simulator or phone from Overview to see the result.'
                  : c.project.status === 'running'
                    ? `Waiting for ${app.url.replace(/^https?:\/\//, '')} to answer.`
                    : 'Start the environment from Overview and the running app appears here. Conversations work either way.'}
              </p>
              <button onClick={onOpenOverview} className="btn-secondary mt-4 h-[34px] px-4">
                Go to Overview
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatRail({ c }: { c: ProjectController }) {
  const convo = c.openConversation;
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-r border-line bg-surface">
      {convo || c.composingNew ? <Thread c={c} convo={convo} /> : <ConversationList c={c} />}
    </aside>
  );
}

function ConversationList({ c }: { c: ProjectController }) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="section-label">Chats · {c.selectedApp.name}</span>
        <button onClick={c.newChat} className="btn-secondary h-7 px-2.5 text-[12.5px]">
          New chat
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {c.conversations.length === 0 ? (
          <p className="px-4 py-6 text-[13px] leading-normal text-muted">
            Nothing asked about {c.selectedApp.name} yet. Describe a change below — what you see on
            the right is what it changes.
          </p>
        ) : (
          <ul>
            {c.conversations.map((v) => (
              <ConversationRow key={v.id} c={c} convo={v} />
            ))}
          </ul>
        )}
      </div>
      <Composer c={c} placeholder={`Ask for a change to ${c.selectedApp.name}…`} />
    </>
  );
}

function ConversationRow({ c, convo }: { c: ProjectController; convo: Conversation }) {
  const last = [...convo.turns].reverse().find((t) => t.role === 'agent');
  const running = c.chatRun(convo.id) !== null;
  return (
    <li>
      <button
        onClick={() => c.showConversation(convo.id)}
        className="flex w-full flex-col gap-0.5 border-b border-line-subtle px-4 py-2.5 text-left hover:bg-hoverfill"
      >
        <span className="flex items-center gap-2">
          <StatusDot status={running ? 'running' : last?.status} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {convo.title}
          </span>
          <span className="shrink-0 text-[11px] text-faint">{ago(convo.updatedAt)}</span>
        </span>
        <span className="truncate pl-4 text-[12px] text-muted">
          {running
            ? 'Working…'
            : last?.text
              ? last.text.split('\n')[0]
              : `${convo.turns.length} message${convo.turns.length === 1 ? '' : 's'}`}
        </span>
      </button>
    </li>
  );
}

function Thread({ c, convo }: { c: ProjectController; convo: Conversation | null }) {
  const end = useRef<HTMLDivElement>(null);
  const run = convo ? c.chatRun(convo.id) : null;
  const log = run?.log ?? '';
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [convo?.turns.length, log.length]);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <button
          onClick={() => c.showConversation(null)}
          className="h-7 shrink-0 rounded-md px-2 text-[12.5px] text-muted hover:bg-hoverfill hover:text-ink"
          title="All chats"
        >
          ←
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {convo?.title ?? 'New chat'}
        </span>
        {convo && (
          <span className="shrink-0 text-[11px] text-faint">{AGENT_LABEL[convo.agent]}</span>
        )}
        {convo && (
          <button
            onClick={() => c.deleteConversation(convo.id)}
            className="shrink-0 text-[12px] text-muted hover:text-danger"
            title="Delete this conversation"
          >
            Delete
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {!convo && (
          <p className="text-[13px] leading-normal text-muted">
            A new conversation about {c.selectedApp.name}, with{' '}
            {AGENT_LABEL[c.agentForApp(c.selectedApp.id)]}. It remembers what was said, so you can
            keep refining.
          </p>
        )}
        {convo?.turns.map((t) => (
          <Turn key={t.id} turn={t} log={t.runId === run?.handle.runId ? log : ''} />
        ))}
        <div ref={end} />
      </div>
      {run && convo && (
        <div className="flex items-center justify-between border-t border-line-subtle px-4 py-1.5 text-[12px] text-muted">
          <span className="min-w-0 truncate">{latestActivity(log) ?? 'Working…'}</span>
          <button
            onClick={() => c.stopChat(convo.id)}
            className="shrink-0 text-danger hover:underline"
          >
            Stop
          </button>
        </div>
      )}
      <Composer
        c={c}
        disabled={run !== null}
        placeholder={convo ? 'Reply…' : `Ask for a change to ${c.selectedApp.name}…`}
      />
    </>
  );
}

function Turn({ turn, log }: { turn: ChatTurn; log: string }) {
  if (turn.role === 'user') {
    return (
      <div className="ml-8 whitespace-pre-wrap rounded-lg bg-sunken px-3 py-2 text-[13px] leading-relaxed text-ink">
        {turn.text}
      </div>
    );
  }
  if (turn.status === 'running') {
    const sofar = replySoFar(log);
    return (
      <div className="flex gap-2 text-[13px] leading-relaxed text-body">
        <span className="dot-pulse mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
        <span className="whitespace-pre-wrap">{sofar ? <Inline text={sofar} /> : 'Thinking…'}</span>
      </div>
    );
  }
  return (
    <div className="text-[13px] leading-relaxed">
      <p
        className={`whitespace-pre-wrap ${
          turn.status === 'failed'
            ? 'text-danger'
            : turn.status === 'stopped'
              ? 'text-muted'
              : 'text-body'
        }`}
      >
        <Inline text={turn.text} />
      </p>
      {turn.restart && (
        <p className="mt-1 text-[11.5px] text-muted">Restarted the app to apply this.</p>
      )}
    </div>
  );
}

function Composer({
  c,
  placeholder,
  disabled = false,
}: {
  c: ProjectController;
  placeholder: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!draft.trim() || disabled || sending) return;
    setSending(true);
    const ok = await c.sendMessage(draft);
    setSending(false);
    if (ok) setDraft('');
  };
  return (
    <div className="border-t border-line p-3">
      {c.chatError && (
        <p className="mb-2 rounded-md border border-danger/30 bg-red-50 px-2.5 py-1.5 text-[12px] text-danger">
          {c.chatError}
        </p>
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
        placeholder={placeholder}
        disabled={sending}
        className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-faint focus:border-muted disabled:opacity-60"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-faint">
          {disabled ? 'Answering…' : 'Enter to send · Shift+Enter for a new line'}
        </span>
        <button
          onClick={() => void send()}
          disabled={!draft.trim() || disabled || sending}
          className="btn-primary h-7 px-3 text-[12.5px] disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * The little markdown agents reach for even when asked for plain sentences:
 * **bold** and `code`. Rendered rather than shown as punctuation; anything
 * more is left as the text it is.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') && p.length > 4 ? (
          <strong key={i} className="font-semibold text-ink">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
          <code key={i} className="rounded bg-sunken px-1 font-mono text-[12px]">
            {p.slice(1, -1)}
          </code>
        ) : (
          p
        )
      )}
    </>
  );
}

function StatusDot({ status }: { status?: ChatTurn['status'] }) {
  const tone =
    status === 'running'
      ? 'dot-pulse bg-brand'
      : status === 'failed'
        ? 'bg-danger'
        : status === 'done'
          ? 'bg-go'
          : 'bg-dot-idle';
  return <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
