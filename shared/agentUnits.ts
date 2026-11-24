import type { AgentKind } from './types';

/**
 * Agent work handed over as steps, each checked before the next.
 *
 * What crosses from the window to the main process when a long job is run as
 * several short ones (see unitRunner.ts for why). The window knows what the
 * steps are and how to brief an agent on each; the main process is the one
 * that can run a command and read a file, so it does the running and the
 * checking. A check therefore crosses as data — a description of evidence to
 * look for — never as code.
 */

/** Evidence the main process can look for, without asking the agent. */
export type UnitCheckSpec =
  /** Each of these files exists and is not empty. Workspace-relative. */
  | { kind: 'files'; paths: string[] }
  /** The file exists and contains every one of these strings. */
  | { kind: 'contains'; path: string; needles: string[] }
  /** `docker compose config` accepts the generated stack as written. */
  | { kind: 'compose-config'; linked: boolean }
  /** mvpfy.yml names the app's port, and names the same one in both places. */
  | { kind: 'manifest-ports'; path: string }
  /** The demo login the env file defines is the one mvpfy.yml will show. */
  | { kind: 'demo-login'; manifest: string; env: string };

export interface AgentUnit {
  /** Stable: it is what a later run uses to know this step was finished. */
  id: string;
  /** For the product manager, in the run's log. */
  title: string;
  /** The whole brief, for an agent that knows nothing yet. */
  promptText: string;
  /**
   * The brief for an agent already in the job's conversation: what this step
   * is, without repeating what it was told at the start. Used only when the
   * conversation is shared and still there; `promptText` is always enough.
   */
  resumeText?: string;
  checks: UnitCheckSpec[];
}

export interface RunAgentUnitsRequest {
  /** One run as far as the window is concerned, however many steps it takes. */
  runId: string;
  agent: AgentKind;
  model?: string;
  repoPath: string;
  units: AgentUnit[];
  /** Tries per step, the first included. */
  maxAttempts: number;
  /** Where an agent writes when only a person can unblock it. Workspace-relative. */
  questionsFile: string;
  /** Where finished steps are recorded. Workspace-relative. */
  progressFile: string;
  /**
   * Run every step in one agent conversation, so the product is read once
   * and a step that is sent back is fixed by the agent that wrote it.
   */
  shareConversation: boolean;
  /**
   * Carry on from the steps already recorded as finished, rather than doing
   * every step again. True when the product manager answered a question;
   * false when they asked for setup afresh.
   */
  resume: boolean;
}

/** Steps a previous run finished, as written to the progress file. */
export interface UnitProgress {
  version: 1;
  done: string[];
  /**
   * The conversation the steps share, so a run that carries on later can
   * carry on in it. Tied to the agent that opened it: an id means nothing
   * to the other one.
   */
  conversation?: { agent: AgentKind; id: string };
}

export function parseUnitProgress(content: string | null | undefined): UnitProgress {
  try {
    const raw = JSON.parse(content ?? '') as { version?: unknown; done?: unknown };
    if (raw?.version === 1 && Array.isArray(raw.done)) {
      const c = (raw as { conversation?: { agent?: unknown; id?: unknown } }).conversation;
      const agent: AgentKind | null =
        c?.agent === 'claude' || c?.agent === 'codex' ? c.agent : null;
      const conversation =
        agent && typeof c?.id === 'string' && c.id ? { agent, id: c.id } : undefined;
      return {
        version: 1,
        done: raw.done.filter((id): id is string => typeof id === 'string'),
        ...(conversation ? { conversation } : {}),
      };
    }
  } catch {
    // Missing, empty or mangled all mean the same thing: nothing is known to be finished.
  }
  return { version: 1, done: [] };
}

export function serializeUnitProgress(progress: UnitProgress): string {
  return JSON.stringify(progress, null, 2) + '\n';
}

/**
 * The brief for a step whose check did not pass.
 *
 * The original brief in full, with what went wrong in front of it: each run
 * is a new conversation, and a failure without the instructions it failed
 * against is an invitation to make the check pass by any means.
 */
export function repairPromptFor(
  original: string,
  repair: { failure: string; attempt: number; of: number }
): string {
  return [
    `This is attempt ${repair.attempt} of ${repair.of} at this step. What the previous attempt wrote is`,
    'still in the workspace. mvpfy then checked the result itself, and it did not hold:',
    '',
    repair.failure,
    '',
    'Fix exactly that, keeping everything else the previous attempt got right. Do not start',
    'the step over, and do not make the check pass by removing what it is checking.',
    '',
    'The original instructions follow.',
    '',
    original,
  ].join('\n');
}
