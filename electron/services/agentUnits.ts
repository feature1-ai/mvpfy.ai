import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentUnit,
  RunAgentUnitsRequest,
  parseUnitProgress,
  repairPromptFor,
  serializeUnitProgress,
} from '../../shared/agentUnits';
import { codexThreadId, lostConversation } from '../../shared/agentConversation';
import { RunSession } from '../../shared/types';
import { UnitDriver, runUnits } from '../../shared/unitRunner';
import { isAllowedWorkspace } from '../paths';
import { PreparedAgentCommand, prepareAgentCommand, removeQuietly } from './agents';
import { readRepoFiles, writeRepoFile } from './repoFiles';
import { StepResult, SteppedRun, beginSteppedRun } from './runs';
import { CheckAccess, failedChecks, workspaceAccess } from './unitChecks';

/**
 * A long agent job run as short steps, each checked before the next.
 *
 * The window asks for one run and watches one run: a single id, one log, one
 * exit. Underneath, each step is its own agent invocation. After it, mvpfy
 * looks at what was left behind (unitChecks.ts), and a step whose evidence
 * is missing goes back to the agent with exactly what was missing, a bounded
 * number of times. The loop itself is shared/unitRunner.ts; this file is the
 * part that knows about processes, files and the run's log.
 *
 * The steps share one agent conversation when asked to. The product is then
 * read once instead of once per step, and a step that is sent back is fixed
 * by the agent that wrote it, with its reasons still in mind. Three things
 * keep that from becoming a liability:
 *   • a conversation that turns out not to exist is replaced by a fresh one
 *     carrying the whole brief, once, without failing the step;
 *   • the last attempt at a failing step always starts fresh — the context
 *     that produced the same mistake twice is the likeliest thing keeping it;
 *   • every brief restates what this step is, because the earlier turns are
 *     still in view, "leave that for later" included.
 *
 * How the run ends is deliberately the same three ways a single agent run
 * could already end, so nothing downstream needs to learn anything:
 *   • 0 — finished, or stopped to ask the product manager something (the
 *     questions file says which, exactly as before);
 *   • the agent's own non-zero code — it crashed or was stopped;
 *   • 1 — a step's check still failed after every attempt, with the step and
 *     the reason as the last lines of the log, where the diagnosis that
 *     follows a failed setup already looks.
 */

/** Everything this needs from outside itself, so a test can stand in for all of it. */
export interface AgentUnitsDeps {
  begin(runId: string): SteppedRun;
  prepare(
    unit: { promptText: string; session?: RunSession },
    req: RunAgentUnitsRequest,
    repoPath: string,
    scratchId: string
  ): PreparedAgentCommand;
  /** A new conversation id. Injected so a test knows what it will be. */
  newId(): string;
  discard(files: string[]): void;
  access(repoPath: string): CheckAccess;
  read(repoPath: string, relativePath: string): string | null;
  write(repoPath: string, relativePath: string, content: string): void;
}

const realDeps: AgentUnitsDeps = {
  begin: beginSteppedRun,
  prepare: (unit, req, repoPath, scratchId) =>
    prepareAgentCommand(
      {
        runId: req.runId,
        agent: req.agent,
        repoPath,
        promptText: unit.promptText,
        ...(req.model ? { model: req.model } : {}),
        ...(unit.session ? { session: unit.session } : {}),
      },
      repoPath,
      scratchId
    ),
  newId: randomUUID,
  discard: removeQuietly,
  access: workspaceAccess,
  read: (repoPath, relativePath) => {
    const [file] = readRepoFiles(repoPath, [relativePath]);
    return file?.exists ? (file.content ?? '') : null;
  },
  write: writeRepoFile,
};

/** Why the run is ending early: the exit code to end it with. */
type Stop = number | null;

/**
 * Start the run and return at once, as starting any run does. Everything
 * after this is reported through the run's own output and its exit.
 */
export function runAgentUnits(req: RunAgentUnitsRequest, deps: AgentUnitsDeps = realDeps): void {
  const repoPath = path.resolve(req.repoPath);
  if (!isAllowedWorkspace(repoPath)) {
    throw new Error('Agent runs are restricted to managed and linked project directories');
  }
  if (!fs.existsSync(repoPath)) throw new Error(`Repo path does not exist: ${repoPath}`);
  if (req.units.length === 0) throw new Error('There are no steps to run');
  const run = deps.begin(req.runId);
  void drive(req, repoPath, run, deps).then(
    (code) => run.end(code),
    (error: Error) => {
      // Nothing above should throw, and a run that never exits disables the
      // whole project until the app restarts — so if something does, it ends.
      run.say(`Setup stopped unexpectedly: ${error.message}`, 'stderr');
      run.end(1);
    }
  );
}

/** Exposed for tests: the whole run, resolving with the code it should exit with. */
export async function drive(
  req: RunAgentUnitsRequest,
  repoPath: string,
  run: SteppedRun,
  deps: AgentUnitsDeps
): Promise<Stop> {
  const { units } = req;
  const access = deps.access(repoPath);
  const position = (unit: AgentUnit) => `step ${units.indexOf(unit) + 1} of ${units.length}`;

  // Asked to start afresh, what an earlier run finished is not evidence about
  // this one: the files may be the very ones being replaced.
  const progress = req.resume
    ? parseUnitProgress(deps.read(repoPath, req.progressFile))
    : { version: 1 as const, done: [] };
  const known = new Set(units.map((u) => u.id));
  progress.done = progress.done.filter((id) => known.has(id));
  const save = () => deps.write(repoPath, req.progressFile, serializeUnitProgress(progress));
  save();
  if (progress.done.length > 0) {
    const kept = units.filter((u) => progress.done.includes(u.id)).map((u) => u.title);
    run.say(`── Carrying on. Already finished and checked: ${kept.join('; ')} ──`);
  }

  // The conversation the steps share. `open` means an agent has actually
  // answered in it: an id that was only minted names nothing yet.
  const kept = req.resume && req.shareConversation ? progress.conversation : undefined;
  let conversation: { id: string | null; open: boolean } =
    kept && kept.agent === req.agent ? { id: kept.id, open: true } : { id: null, open: false };
  const remember = () => {
    if (conversation.open && conversation.id) {
      progress.conversation = { agent: req.agent, id: conversation.id };
    } else {
      delete progress.conversation;
    }
    save();
  };

  let invocation = 0;
  /** One agent invocation: in the shared conversation, or opening a new one. */
  const invoke = async (unit: AgentUnit, brief: (text: string) => string, fresh: boolean) => {
    const continuing = req.shareConversation && conversation.open && !fresh;
    if (!continuing) conversation = { id: null, open: false };
    let session: RunSession | undefined;
    if (req.shareConversation) {
      if (continuing && conversation.id) {
        session = { id: conversation.id, resume: true };
      } else if (req.agent === 'claude') {
        // Claude is told which id to open. Codex chooses its own, and says.
        conversation.id = deps.newId();
        session = { id: conversation.id, resume: false };
      }
    }
    const promptText = brief(continuing ? (unit.resumeText ?? unit.promptText) : unit.promptText);
    const prepared = deps.prepare(
      { promptText, ...(session ? { session } : {}) },
      req,
      repoPath,
      `${req.runId}-${(invocation += 1)}`
    );
    let result: StepResult;
    try {
      result = await run.step(prepared.command, repoPath, prepared.env);
    } finally {
      deps.discard(prepared.scratch);
    }
    if (req.shareConversation && result.code === 0) {
      if (!conversation.id) conversation.id = codexThreadId(result.output);
      conversation.open = Boolean(conversation.id);
      remember();
    }
    return { result, continued: continuing };
  };

  const driver: UnitDriver<AgentUnit, Stop> = {
    work: async (unit, attempt) => {
      if (run.stopped()) return { kind: 'stop', stop: null };
      run.say(
        attempt.number === 1
          ? `── ${capitalise(position(unit))}: ${unit.title} ──`
          : `── Fixing ${position(unit)}: ${unit.title} (attempt ${attempt.number} of ${attempt.of}) ──`
      );
      const brief = (text: string) =>
        attempt.failure === undefined
          ? text
          : repairPromptFor(text, {
              failure: attempt.failure,
              attempt: attempt.number,
              of: attempt.of,
            });
      // The last try at a step that keeps failing leaves the conversation
      // behind: whatever is in it has now produced the same mistake twice.
      const lastTry = attempt.number > 1 && attempt.number === attempt.of;
      const first = await invoke(unit, brief, lastTry);
      let { result } = first;
      if (
        first.continued &&
        result.code !== 0 &&
        !run.stopped() &&
        lostConversation(result.output)
      ) {
        // Not a failure of the work: there was nothing to continue. Once,
        // with the whole brief, and the step goes on as if it had started so.
        run.say('── The earlier conversation is no longer there; starting a fresh one ──');
        ({ result } = await invoke(unit, brief, true));
      }
      const { code } = result;
      // null, not `code`: a step that finished cleanly leaves code 0, and
      // returning that here would report a run the PM stopped as one that
      // succeeded. The setup chain in useProjectActions starts the stack on
      // exit code 0, so a Stop pressed in the moment between two steps would
      // bring the product up with no manifest, no database and no demo login.
      // Every other stopped() branch in this driver returns null for the same
      // reason; this one used to be the exception.
      if (run.stopped()) return { kind: 'stop', stop: null };
      if (code !== 0) {
        run.say(
          `Setup stopped during ${position(unit)} (${unit.title}): the agent ended with ` +
            `${code === null ? 'no exit code' : `exit code ${code}`}.`,
          'stderr'
        );
        return { kind: 'stop', stop: code ?? 1 };
      }
      // An agent that is blocked writes its questions and exits zero. The
      // step is not finished and is not marked so; the run ends the way a
      // blocked run always has, and the answer brings it back to this step.
      if ((deps.read(repoPath, req.questionsFile) ?? '').trim()) {
        run.say(`── Stopped at ${position(unit)} to ask you something ──`);
        return { kind: 'stop', stop: 0 };
      }
      return { kind: 'done' };
    },

    check: async (unit) => {
      if (run.stopped()) return { kind: 'stop', stop: null };
      const failures = await failedChecks(unit.checks, access);
      if (run.stopped()) return { kind: 'stop', stop: null };
      if (failures.length === 0) {
        run.say(`✓ ${unit.title} — checked`);
        return { kind: 'passed' };
      }
      const failure = failures.join('\n\n');
      run.say(`✗ ${unit.title} — not there yet:\n${failure}`);
      return { kind: 'failed', failure };
    },
  };

  const outcome = await runUnits(
    units,
    driver,
    {
      isDone: (unit) => progress.done.includes(unit.id),
      markDone: (unit) => {
        progress.done.push(unit.id);
        save();
      },
    },
    { maxAttempts: req.maxAttempts }
  );

  if (outcome.kind === 'completed') return 0;
  if (outcome.kind === 'stopped') return outcome.stop;
  run.say(
    `Setup stopped at ${position(outcome.unit)} (${outcome.unit.title}). After ` +
      `${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'} this still does not hold:\n` +
      outcome.failure,
    'stderr'
  );
  return 1;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
