import * as crypto from 'node:crypto';
import { agentReply, titleFrom } from '../shared/chat';
import { codexThreadId, lostConversation } from '../shared/agentConversation';
import { hostedChatPrompt } from '../shared/chatPrompt';
import { RunSession } from '../shared/types';
import { AgentKind, AgentRunner } from './agentRun';
import { Git } from './git';
import { PullRequests } from './prs';
import { Verifier, canReport } from './verify';

/**
 * A conversation beside a test link: the desktop App tab, hosted.
 *
 * A product manager looks at the feature running on its test link and says
 * what they want different. The agent works in that link's own checkout,
 * where the development server is watching, so what it saves is on their
 * screen in seconds. Then mvpfy does what the desktop leaves to the person:
 * commits the change, runs the repository's checks, and — when they pass —
 * adds it to the feature's pull request and tells Feature1. A change that
 * fails its checks gets one repair and is otherwise kept back, with Undo.
 *
 * Unlike the desktop, a change is made straight away: asked for in the
 * chat, it is made, and Undo takes it away again. A question is only
 * answered.
 */

/** What the person sent, written by mvpfy-cloud beside the conversation. */
export interface ChatRequest {
  message: string;
  /** The work item's code in Feature1, e.g. THA-F-11. */
  code: string;
  title: string;
  /** Who sent it, as Feature1 knows them. */
  by?: string;
}

/** One repository of the link's checkout. */
export interface ChatRepository {
  id: string;
  name: string;
  /** Its checkout, inside the link's. */
  dir: string;
  /** The feature's branch, when this build changed this repository; null when it is on its base. */
  branch: string | null;
  base: string;
}

/** The agent's conversation, kept between turns. */
export interface ChatSession {
  agent: AgentKind;
  id: string | null;
}

export interface ChatCheck {
  repository: string;
  name: string;
  outcome: string;
}

export interface ChatOutcome {
  reply: string;
  error: string | null;
  /** Files changed and were committed. */
  changed: boolean;
  commits: Array<{ repository: string; sha: string }>;
  checks: ChatCheck[];
  pushed: boolean;
  /** Why a change was kept back from the pull request. */
  notPushed: string | null;
  pullRequest: string | null;
  noted: boolean;
  restarted: boolean;
}

export interface ChatDeps {
  agent: AgentRunner;
  agentKind: AgentKind;
  agentModel?: string;
  git: Pick<
    Git,
    | 'uncommitted'
    | 'commit'
    | 'pushHead'
    | 'exclude'
    | 'originUrl'
    | 'revert'
    | 'hasCommit'
    | 'headCommit'
    | 'resetTo'
  >;
  verifier: Pick<Verifier, 'verifyRepository'>;
  pullRequests: Pick<PullRequests, 'findExisting' | 'comment'>;
  /** A note on the work item in Feature1; false when it could not be made. */
  note: (body: string) => Promise<boolean>;
  /** Restart the link's stack, for a change it only picks up that way. */
  restart: () => Promise<void>;
  template: string;
  guidance?: string;
  session: { load(): ChatSession | null; save(session: ChatSession | null): void };
  agentDir: string;
  questionsFile: string;
  newId?: () => string;
  log: (message: string) => void;
}

const SUBJECT_LIMIT = 72;

function subjectFor(message: string): string {
  const title = titleFrom(message);
  const subject = `Change from the test link: ${title}`;
  return subject.length > SUBJECT_LIMIT ? `${subject.slice(0, SUBJECT_LIMIT - 1)}…` : subject;
}

/** Commit what changed in each repository; the commits made. */
async function commitChanges(
  repos: ChatRepository[],
  deps: ChatDeps,
  subject: string
): Promise<Array<{ repository: string; sha: string }>> {
  const commits: Array<{ repository: string; sha: string }> = [];
  for (const repo of repos) {
    const { paths, withheld } = await deps.git.uncommitted(repo.dir);
    for (const file of withheld)
      deps.log(`kept out of the commit, as it looks like a secret: ${file}`);
    const sha = await deps.git.commit(repo.dir, subject, paths);
    if (sha) commits.push({ repository: repo.id, sha });
  }
  return commits;
}

/**
 * Each changed repository's checks: null when they pass; otherwise what went
 * wrong, and whether it is the change's to fix — a check that failed is; a
 * check that could not run at all is not, and no repair would help it.
 */
async function check(
  repos: ChatRepository[],
  changed: Set<string>,
  deps: ChatDeps,
  checks: ChatCheck[]
): Promise<{ reason: string; fixable: boolean } | null> {
  for (const repo of repos.filter((r) => changed.has(r.id))) {
    const results = await deps.verifier.verifyRepository(repo.id, {
      worktrees: { [repo.id]: repo.dir },
    });
    for (const r of results) {
      const at = checks.findIndex((c) => c.repository === repo.name && c.name === r.name);
      const row = { repository: repo.name, name: r.name, outcome: r.outcome };
      if (at === -1) checks.push(row);
      else checks[at] = row;
    }
    const verdict = canReport(results, []);
    if (!verdict.ok) {
      const output = results
        .filter((r) => r.outcome === 'failed' && r.output)
        .map((r) => `${r.name}:\n${r.output}`)
        .join('\n\n')
        .slice(-6000);
      return {
        reason: `${repo.name}: ${verdict.reason}${output ? `\n\n${output}` : ''}`,
        // A failed install is the environment's, not the change's.
        fixable: results.some((r) => r.outcome === 'failed' && !r.stepId.startsWith('install-')),
      };
    }
  }
  return null;
}

/** Run one message through the agent, in the conversation's own session. */
async function ask(
  workspace: string,
  prompt: string,
  deps: ChatDeps
): Promise<{ text: string; restart: boolean; error: string | null }> {
  const kept = deps.session.load();
  const sameAgent = kept?.agent === deps.agentKind ? kept : null;
  // Claude takes a session id mvpfy names; codex names its own, found after.
  const session: RunSession | undefined =
    deps.agentKind === 'claude'
      ? { id: sameAgent?.id ?? (deps.newId ?? crypto.randomUUID)(), resume: !!sameAgent?.id }
      : sameAgent?.id
        ? { id: sameAgent.id, resume: true }
        : undefined;
  const outcome = await deps.agent.run({
    kind: deps.agentKind,
    ...(deps.agentModel ? { model: deps.agentModel } : {}),
    prompt,
    cwd: workspace,
    agentDir: deps.agentDir,
    questionsFile: deps.questionsFile,
    ...(session ? { session } : {}),
    timeoutMs: 30 * 60_000,
  });
  const output = outcome.output ?? '';
  if (lostConversation(output)) {
    deps.session.save(null);
    return {
      text: '',
      restart: false,
      error: 'The agent had lost this conversation. Send the message again to start afresh.',
    };
  }
  const id =
    deps.agentKind === 'claude' ? (session?.id ?? null) : (session?.id ?? codexThreadId(output));
  deps.session.save({ agent: deps.agentKind, id });
  const reply = agentReply(output);
  const failed =
    reply.error ??
    (outcome.timedOut
      ? 'The agent ran out of time.'
      : outcome.code !== 0 && !reply.text
        ? `The agent stopped (exit ${outcome.code}).`
        : null);
  return { text: reply.text, restart: reply.restart, error: failed };
}

/** One message: answered, and when it asked for a change, the change made, checked and added. */
export async function chatTurn(
  workspace: string,
  repos: ChatRepository[],
  request: ChatRequest,
  deps: ChatDeps
): Promise<ChatOutcome> {
  for (const repo of repos) await deps.git.exclude(repo.dir, '/.mvpfy/');
  const outcome: ChatOutcome = {
    reply: '',
    error: null,
    changed: false,
    commits: [],
    checks: [],
    pushed: false,
    notPushed: null,
    pullRequest: null,
    noted: false,
    restarted: false,
  };
  const resumed = !!deps.session.load()?.id;
  const first = await ask(
    workspace,
    hostedChatPrompt(deps.template, {
      repoPath: workspace,
      resume: resumed,
      workTitle: `${request.code} — ${request.title}`,
      ...(deps.guidance ? { guidance: deps.guidance } : {}),
      message: request.message,
    }),
    deps
  );
  outcome.reply = first.text;
  outcome.error = first.error;
  let restart = first.restart;

  // What changed on disk decides, not what the reply says: a reply can claim
  // a change it did not make, or forget to say it made one.
  const subject = subjectFor(request.message);
  outcome.commits = await commitChanges(repos, deps, subject);
  if (outcome.commits.length === 0) return outcome;
  outcome.changed = true;

  const changed = new Set(outcome.commits.map((c) => c.repository));
  let failure = await check(repos, changed, deps, outcome.checks);
  if (failure?.fixable) {
    deps.log('the checks failed after the change; giving the agent one go at fixing it');
    const repair = await ask(
      workspace,
      hostedChatPrompt(deps.template, {
        repoPath: workspace,
        resume: true,
        workTitle: `${request.code} — ${request.title}`,
        ...(deps.guidance ? { guidance: deps.guidance } : {}),
        message:
          `(From mvpfy, not the product manager.) After your change, the repository's checks ` +
          `failed:\n\n${failure.reason}\n\nFix what broke, keeping the change they asked for. Reply ` +
          'in one or two plain sentences, and end with the same two lines.',
      }),
      deps
    );
    restart = restart || repair.restart;
    const fixes = await commitChanges(repos, deps, `${subject} (fixing its checks)`);
    outcome.commits.push(...fixes);
    for (const f of fixes) changed.add(f.repository);
    failure = await check(repos, changed, deps, outcome.checks);
  }

  if (restart) {
    await deps.restart().then(
      () => (outcome.restarted = true),
      (error: Error) => deps.log(`the link could not be restarted: ${error.message}`)
    );
  }

  if (failure) {
    outcome.notPushed = failure.fixable
      ? `Its checks still fail, so it was not added to the pull request. ${failure.reason.split('\n')[0]}`
      : `Its checks could not run, so it was not added to the pull request. ${failure.reason.split('\n')[0]}`;
    return outcome;
  }
  const offBranch = repos.filter((r) => changed.has(r.id) && !r.branch);
  if (offBranch.length > 0) {
    outcome.notPushed =
      `It changed ${offBranch.map((r) => r.name).join(', ')}, which this build's pull request ` +
      'does not include, so it was not pushed.';
    return outcome;
  }

  for (const repo of repos.filter((r) => changed.has(r.id))) {
    await deps.git.pushHead(repo.dir, repo.branch ?? '', repo.base);
  }
  outcome.pushed = true;

  const body = [
    `**Changed from the test link**${request.by ? ` by ${request.by}` : ''}:`,
    '',
    `> ${request.message.trim().split('\n').join('\n> ')}`,
    '',
    outcome.reply || '(no reply)',
    '',
    `Commits: ${outcome.commits.map((c) => c.sha.slice(0, 12)).join(', ')} · checks passed`,
  ].join('\n');
  for (const repo of repos.filter((r) => changed.has(r.id))) {
    const github = PullRequests.repoFrom(await deps.git.originUrl(repo.dir));
    if (!github || !repo.branch) continue;
    const pr = await deps.pullRequests.findExisting({
      worktree: repo.dir,
      owner: github.owner,
      name: github.name,
      headBranch: repo.branch,
      baseBranch: repo.base,
      title: '',
      body: '',
    });
    if (!pr) continue;
    outcome.pullRequest ??= pr.url;
    await deps.pullRequests.comment({ worktree: repo.dir, ...github }, pr.number, body);
  }
  outcome.noted = await deps.note(
    `${body}${outcome.pullRequest ? `\n\nPull request: ${outcome.pullRequest}` : ''}\n\n_Recorded by mvpfy._`
  );
  return outcome;
}

/**
 * Undo a change made in the chat: revert its commits, newest first — a
 * change and the fix to its checks are one change — and take it out of the
 * pull request too.
 */
export async function chatUndo(
  repos: ChatRepository[],
  shas: string[],
  deps: Pick<ChatDeps, 'git' | 'restart' | 'log'>,
  options: { pushed?: boolean } = {}
): Promise<{ reverted: string | null; pushed: boolean; error: string | null }> {
  // Never pushed, and still the last thing in the checkout: drop it, rather
  // than add a revert that the next push would carry with it.
  if (options.pushed === false) {
    for (const repo of repos) {
      const first = shas[0];
      const last = shas[shas.length - 1];
      if (!first || !last || !(await deps.git.hasCommit(repo.dir, last))) continue;
      if ((await deps.git.headCommit(repo.dir)) !== last) break;
      await deps.git.resetTo(repo.dir, `${first}^`);
      return { reverted: await deps.git.headCommit(repo.dir), pushed: false, error: null };
    }
  }
  let reverted: string | null = null;
  const touched = new Set<ChatRepository>();
  for (const sha of [...shas].reverse()) {
    const repo = await (async () => {
      for (const r of repos) if (await deps.git.hasCommit(r.dir, sha)) return r;
      return null;
    })();
    if (!repo)
      return { reverted, pushed: false, error: `This link has no commit ${sha.slice(0, 12)}` };
    reverted = await deps.git.revert(repo.dir, sha);
    touched.add(repo);
  }
  const unpushable = [...touched].filter((r) => !r.branch);
  if (unpushable.length) return { reverted, pushed: false, error: null };
  try {
    for (const repo of touched) await deps.git.pushHead(repo.dir, repo.branch ?? '', repo.base);
    return { reverted, pushed: touched.size > 0, error: null };
  } catch (error) {
    return {
      reverted,
      pushed: false,
      error: `Undone here, but not pushed: ${(error as Error).message}`,
    };
  }
}

/** One line for mvpfy-cloud to read off the log. */
export function chatLine(kind: 'turn' | 'undo', value: object): string {
  return `CHAT ${JSON.stringify({ kind, ...value })}`;
}
