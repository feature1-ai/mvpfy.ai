import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeCommandFor, codexCommandFor, posixShell } from '../shared/agentCommands';
import { CommandRunner, CommandResult } from './exec';

/**
 * Running the coding agent, once, for one unit of work.
 *
 * Thin on purpose. The flag assembly is shared with the desktop app so the
 * two cannot drift, and everything specific to running unattended lives
 * here: the prompt goes to a file rather than an argument list, the agent's
 * own output never leaves the worker, and a questions file is treated as the
 * agent's way of stopping to ask rather than as a failure.
 */

export type AgentKind = 'claude' | 'codex';

export interface AgentOutcome {
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
  /** Questions the agent wrote instead of guessing. Empty when it did not. */
  questions: string[];
  /** Redacted tail, kept on the worker for the operator. Never reported. */
  tail: string;
}

export interface AgentRunner {
  run(input: {
    kind: AgentKind;
    model?: string;
    prompt: string;
    cwd: string;
    agentDir: string;
    questionsFile: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<AgentOutcome>;
}

/**
 * Numbered questions out of the file the agent was told to write.
 *
 * Deliberately forgiving about the format — an agent asked for a numbered
 * list produces several — because the alternative to reading a slightly
 * unexpected list is reporting a silent stall.
 */
export function parseQuestions(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^#/.test(line))
    .slice(0, 20);
}

export class CliAgentRunner implements AgentRunner {
  constructor(
    private readonly runner: CommandRunner,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async run(input: Parameters<AgentRunner['run']>[0]): Promise<AgentOutcome> {
    fs.mkdirSync(input.agentDir, { recursive: true });
    const promptFile = path.join(input.agentDir, `prompt-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, input.prompt, 'utf8');
    // A stale questions file from an earlier attempt would block this one
    // before it started — which is a real bug mvpfy has had before.
    fs.rmSync(input.questionsFile, { force: true });

    const opts = { repoPath: input.cwd, promptFile };
    const req = { ...(input.model ? { model: input.model } : {}) };
    const command =
      input.kind === 'claude'
        ? claudeCommandFor(req, opts, posixShell)
        : codexCommandFor(req, opts, posixShell);

    let res: CommandResult;
    try {
      res = await this.runner.run(command, {
        cwd: input.cwd,
        env: this.env,
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: input.timeoutMs ?? 2 * 60 * 60_000,
      });
    } finally {
      fs.rmSync(promptFile, { force: true });
    }

    let questions: string[] = [];
    try {
      questions = parseQuestions(fs.readFileSync(input.questionsFile, 'utf8'));
    } catch {
      // No questions file is the ordinary case.
    }
    return {
      code: res.code,
      cancelled: res.cancelled,
      timedOut: res.timedOut,
      questions,
      tail: (res.stderr || res.stdout).slice(-4000),
    };
  }
}
