import { useEffect, useRef, useState } from 'react';
import type { AgentKind, ChatTurn, Conversation, RunSession } from '../../shared/types';
import { codexThreadId, isTrunkBased, lostConversation, startChatRun } from '../lib/agentRunner';
import { AppTarget, PROJECT_APP_ID, agentReply, titleFrom } from '../lib/chat';
import { preflightAuth } from '../lib/cliCheck';
import type { RunState } from '../lib/useRuns';
import { ControllerContext } from './controllerContext';

export interface AppChat {
  /** The parts of the product the App tab can show and talk to, the whole project first. */
  appTargets: AppTarget[];
  selectedApp: AppTarget;
  selectApp(id: string): void;
  /** The agent new conversations about this part start with. */
  agentForApp(id: string): AgentKind;
  setAppAgent(id: string, agent: AgentKind): void;
  /** The selected part's conversations, most recently active first. */
  conversations: Conversation[];
  /** The conversation open in the rail, or null for the list / a new chat. */
  openConversation: Conversation | null;
  /** True while the rail shows the new-chat composer rather than the list. */
  composingNew: boolean;
  showConversation(id: string | null): void;
  newChat(): void;
  /** A typed message: answered on a read-only run, never acted on unasked. */
  sendMessage(text: string): Promise<boolean>;
  /** The yes to the change the conversation's last answer proposed: now it is made. */
  approveChange(conversationId: string): Promise<boolean>;
  declineChange(conversationId: string): void;
  stopChat(conversationId: string): void;
  deleteConversation(id: string): void;
  /** The live run answering this conversation, if one is going. */
  chatRun(conversationId: string): RunState | null;
  chatError: string | null;
  /** Bumped when a change lands in a part, so its preview can reload. */
  appChangedAt: Record<string, number>;
}

/** The conversation's last turn, when it is a proposal nobody has answered yet. */
export function pendingProposal(convo: Conversation | null): ChatTurn | null {
  const last = convo?.turns[convo.turns.length - 1];
  return last?.role === 'agent' && last.status === 'done' && last.proposal && !last.decision
    ? last
    : null;
}

/**
 * The App tab's conversations, one runner per part of the product.
 *
 * Talking and changing are separate steps. Whatever is typed is answered on a
 * read-only run: the agent explains, and when a change is wanted it says what
 * it would do and asks. Only the person's explicit yes starts the run that may
 * edit — and, trunk-based, commit.
 *
 * Each conversation keeps its agent's own session, so the second message is
 * read with the first one remembered — claude by an id mvpfy hands it, codex
 * by the thread id it announces. Different parts run side by side; one
 * conversation answers one message at a time.
 */
export function useAppChat(
  ctx: ControllerContext,
  targets: AppTarget[],
  restart: (service?: string) => Promise<unknown>,
  trouble: string
): AppChat {
  const { project, state, updateState, runsApi, projectRuns } = ctx;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [composingNew, setComposingNew] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [restartedAt, setRestartedAt] = useState<Record<string, number>>({});
  const stopping = useRef(new Set<string>());
  const processed = useRef(new Set<string>());

  // The first part with a page of its own is what somebody opening the tab
  // came to look at; the whole project is there for everything else.
  const selectedApp =
    targets.find((t) => t.id === selectedId) ??
    targets.find((t) => t.id !== PROJECT_APP_ID && t.url) ??
    targets[0];

  const all = project.conversations ?? [];
  const conversations = all
    .filter((c) => c.appId === selectedApp.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const openConversation = conversations.find((c) => c.id === openId) ?? null;

  // When a change last landed in each part: an approved change that finished,
  // or a restart that finished since. Derived, so it cannot disagree with the
  // conversations it is read from. An answer changes nothing, so it reloads
  // nothing.
  const appChangedAt: Record<string, number> = { ...restartedAt };
  for (const c of all) {
    for (const t of c.turns) {
      if (t.applied && t.status === 'done') {
        appChangedAt[c.appId] = Math.max(appChangedAt[c.appId] ?? 0, t.at);
      }
    }
  }

  const agentForApp = (id: string): AgentKind =>
    project.appAgents?.[id] ?? state.settings.defaultAgent;

  const writeConversations = (mutate: (list: Conversation[]) => Conversation[]) =>
    updateState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === project.id ? { ...p, conversations: mutate(p.conversations ?? []) } : p
      ),
    }));

  const patchTurn = (
    conversationId: string,
    runId: string,
    patch: Partial<ChatTurn>,
    convo?: Partial<Conversation>
  ) =>
    writeConversations((list) =>
      list.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              ...convo,
              updatedAt: Date.now(),
              turns: c.turns.map((t) => (t.runId === runId ? { ...t, ...patch } : t)),
            }
          : c
      )
    );

  const liveRun = (conversationId: string) =>
    projectRuns.find(
      (r) => r.running && r.handle.kind === 'chat' && r.handle.conversationId === conversationId
    ) ?? null;

  // A turn still marked running whose run is gone was cut off by mvpfy
  // quitting. Said once, on opening the project, rather than left spinning.
  const swept = useRef<string | null>(null);
  useEffect(() => {
    if (swept.current === project.id) return;
    swept.current = project.id;
    const live = new Set(projectRuns.filter((r) => r.running).map((r) => r.handle.runId));
    const stale = (project.conversations ?? []).some((c) =>
      c.turns.some((t) => t.status === 'running' && t.runId && !live.has(t.runId))
    );
    if (!stale) return;
    writeConversations((list) =>
      list.map((c) => ({
        ...c,
        turns: c.turns.map((t) =>
          t.status === 'running' && t.runId && !live.has(t.runId)
            ? { ...t, status: 'stopped' as const, text: t.text || 'Interrupted when mvpfy closed.' }
            : t
        ),
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Codex names its thread on its first line; keep it the moment it appears,
  // so a long first answer whose head scrolls out of the log still resumes.
  useEffect(() => {
    for (const run of projectRuns) {
      if (run.handle.kind !== 'chat' || !run.handle.conversationId) continue;
      const convo = all.find((c) => c.id === run.handle.conversationId);
      if (!convo || convo.agent !== 'codex' || convo.sessionId) continue;
      const thread = codexThreadId(run.log);
      if (thread) {
        writeConversations((list) =>
          list.map((c) => (c.id === convo.id ? { ...c, sessionId: thread } : c))
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRuns]);

  // A finished run becomes the agent's turn: its reply, whether it asked for a
  // restart, and — when it did — the restart, so the change reaches the app
  // without anybody going to look for a button.
  useEffect(() => {
    for (const run of projectRuns) {
      const conversationId = run.handle.conversationId;
      if (run.running || run.handle.kind !== 'chat' || !conversationId) continue;
      if (processed.current.has(run.handle.runId)) continue;
      const convo = all.find((c) => c.id === conversationId);
      const turn = convo?.turns.find((t) => t.runId === run.handle.runId);
      if (!convo || !turn || turn.status !== 'running') continue;
      processed.current.add(run.handle.runId);

      if (stopping.current.delete(run.handle.runId)) {
        const partial = agentReply(run.log).text;
        patchTurn(conversationId, run.handle.runId, {
          status: 'stopped',
          text: partial || 'Stopped.',
        });
        continue;
      }
      if (lostConversation(run.log)) {
        patchTurn(
          conversationId,
          run.handle.runId,
          {
            status: 'failed',
            text: 'The agent could not pick this conversation up again. Send the message again and it starts afresh.',
          },
          { sessionId: undefined }
        );
        continue;
      }
      const reply = agentReply(run.log);
      const failed = run.exitCode !== 0 || reply.error !== null;
      patchTurn(conversationId, run.handle.runId, {
        status: failed ? 'failed' : 'done',
        // Stamped at the finish, so a reload of the preview follows the change.
        at: Date.now(),
        text:
          reply.text ||
          reply.error ||
          (failed ? 'The agent stopped without answering — the log has why.' : 'Done.'),
        restart: !failed && turn.applied === true && reply.restart,
        proposal: !failed && !turn.applied && reply.proposal,
      });
      if (failed || !turn.applied) continue;
      const target = targets.find((t) => t.id === convo.appId);
      if (reply.restart && project.status === 'running') {
        void restart(target?.service).then(() =>
          setRestartedAt((prev) => ({ ...prev, [convo.appId]: Date.now() }))
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRuns]);

  const writeTurns = (
    existing: Conversation | null,
    id: string,
    sessionId: string | undefined,
    agent: AgentKind,
    turns: ChatTurn[],
    title: string
  ) => {
    const now = Date.now();
    writeConversations((list) =>
      existing
        ? list.map((c) =>
            c.id === id
              ? {
                  ...c,
                  ...(sessionId ? { sessionId } : {}),
                  updatedAt: now,
                  turns: [...c.turns, ...turns],
                }
              : c
          )
        : [
            ...list,
            {
              id,
              appId: selectedApp.id,
              title,
              agent,
              ...(sessionId ? { sessionId } : {}),
              createdAt: now,
              updatedAt: now,
              turns,
            },
          ]
    );
  };

  /** Start one run of a conversation and record the turns it answers. */
  const converse = async (
    existing: Conversation | null,
    mode: 'ask' | 'apply',
    userText: string,
    message: string
  ): Promise<void> => {
    if (existing && liveRun(existing.id)) {
      throw new Error('Still answering the last message — wait for it, or stop it.');
    }
    const agent = existing?.agent ?? agentForApp(selectedApp.id);
    const authProblem = await preflightAuth(agent, false);
    if (authProblem) throw new Error(authProblem);
    // A trunk-based change is committed where it is made, so the workspace
    // has to be on the trunk itself — a commit on a detached HEAD reaches no
    // branch, and the push that follows would send nothing.
    if (mode === 'apply' && isTrunkBased(project)) {
      const res = await window.mvpfy.checkoutFeature(
        project.localPath,
        project.repos.map((r) => r.dir),
        null
      );
      if (!res.ok) {
        throw new Error(
          res.error ||
            'Could not put the workspace on its default branch — this project commits chat changes straight to it.'
        );
      }
      if (project.testingSlug) {
        updateState((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...p, testingSlug: null } : p
          ),
        }));
      }
    }

    const id = existing?.id ?? crypto.randomUUID();
    // Claude is handed the id of the conversation it opens; codex opens one
    // unasked and names it, so only its later messages can resume.
    let sessionId = existing?.sessionId;
    let session: RunSession | undefined;
    if (sessionId) session = { id: sessionId, resume: true };
    else if (agent === 'claude') {
      sessionId = crypto.randomUUID();
      session = { id: sessionId, resume: false };
    }
    // The change made is the one proposed, which only the session remembers.
    if (mode === 'apply' && !session?.resume) {
      throw new Error(
        'The agent has lost track of what it proposed. Ask again and it will propose afresh.'
      );
    }

    const handle = await startChatRun(project, state.settings, {
      conversationId: id,
      mode,
      message,
      agent,
      session,
      app: selectedApp,
      trouble,
    });
    runsApi.track(handle);

    const now = Date.now();
    writeTurns(
      existing,
      id,
      sessionId,
      agent,
      [
        { id: crypto.randomUUID(), role: 'user', text: userText, at: now },
        {
          id: crypto.randomUUID(),
          role: 'agent',
          text: '',
          at: now,
          runId: handle.runId,
          status: 'running',
          ...(mode === 'apply' ? { applied: true } : {}),
        },
      ],
      titleFrom(userText)
    );
    setOpenId(id);
    setComposingNew(false);
  };

  const attempt = async (work: () => Promise<void>): Promise<boolean> => {
    setChatError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setChatError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const sendMessage = async (raw: string): Promise<boolean> => {
    const text = raw.trim();
    if (!text) return false;
    return attempt(() => converse(openConversation, 'ask', text, text));
  };

  const setDecision = (conversationId: string, turnId: string, decision: 'approved' | 'declined') =>
    writeConversations((list) =>
      list.map((c) =>
        c.id === conversationId
          ? { ...c, turns: c.turns.map((t) => (t.id === turnId ? { ...t, decision } : t)) }
          : c
      )
    );

  const approveChange = (conversationId: string): Promise<boolean> =>
    attempt(async () => {
      const convo = all.find((c) => c.id === conversationId) ?? null;
      const proposal = pendingProposal(convo);
      if (!convo || !proposal) throw new Error('There is no proposed change waiting for a yes.');
      await converse(convo, 'apply', 'Go ahead.', 'Go ahead.');
      setDecision(convo.id, proposal.id, 'approved');
    });

  const declineChange = (conversationId: string) => {
    const proposal = pendingProposal(all.find((c) => c.id === conversationId) ?? null);
    if (proposal) setDecision(conversationId, proposal.id, 'declined');
  };

  const stopChat = (conversationId: string) => {
    const run = liveRun(conversationId);
    if (!run) return;
    stopping.current.add(run.handle.runId);
    runsApi.stop(run.handle.runId);
  };

  const deleteConversation = (id: string) => {
    if (liveRun(id)) stopChat(id);
    writeConversations((list) => list.filter((c) => c.id !== id));
    if (openId === id) setOpenId(null);
  };

  return {
    appTargets: targets,
    selectedApp,
    selectApp: (id) => {
      setSelectedId(id);
      setOpenId(null);
      setComposingNew(false);
      setChatError(null);
    },
    agentForApp,
    setAppAgent: (id, agent) =>
      updateState((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.id === project.id ? { ...p, appAgents: { ...(p.appAgents ?? {}), [id]: agent } } : p
        ),
      })),
    conversations,
    openConversation,
    composingNew,
    showConversation: (id) => {
      setOpenId(id);
      setComposingNew(false);
      setChatError(null);
    },
    newChat: () => {
      setOpenId(null);
      setComposingNew(true);
      setChatError(null);
    },
    sendMessage,
    approveChange,
    declineChange,
    stopChat,
    deleteConversation,
    chatRun: liveRun,
    chatError,
    appChangedAt,
  };
}
