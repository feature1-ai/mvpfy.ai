import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeCommandFor, codexCommandFor, posixShell } from '../shared/agentCommands';
import { AgentMcpServer, claudeMcpConfig, codexMcpOverride } from '../shared/agentMcp';
import { agentEnv } from './childEnv';
import { CommandRunner, CommandResult } from './exec';
import { RunSession } from '../shared/types';

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
  /**
   * What the agent printed, whole up to a limit: its events, for reading what
   * it said back (shared/chat.ts). Only a conversation reads it.
   */
  output?: string;
}

export interface AgentRunner {
  run(input: {
    kind: AgentKind;
    model?: string;
    prompt: string;
    cwd: string;
    agentDir: string;
    questionsFile: string;
    /**
     * Feature1's MCP server, registered for this run only. Read-only by the
     * token's own scope: the worker hands it over, it does not police it.
     */
    mcp?: AgentMcpServer;
    /** Continue (resume) or open (not resume) a named conversation. */
    session?: RunSession;
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
    private readonly env: NodeJS.ProcessEnv = agentEnv()
  ) {}

  async run(input: Parameters<AgentRunner['run']>[0]): Promise<AgentOutcome> {
    fs.mkdirSync(input.agentDir, { recursive: true });
    const promptFile = path.join(input.agentDir, `prompt-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, input.prompt, 'utf8');
    // A stale questions file from an earlier attempt would block this one
    // before it started — which is a real bug mvpfy has had before.
    fs.rmSync(input.questionsFile, { force: true });

    const opts = { repoPath: input.cwd, promptFile };
    const req = {
      ...(input.model ? { model: input.model } : {}),
      ...(input.session ? { session: input.session } : {}),
    };
    // Per run, and gone after it: nothing is written into the checkout or
    // into the agent's own home, so one execution's access cannot be found
    // by the next.
    const scratch = [promptFile];
    let env = this.env;
    let command: string;
    if (input.kind === 'claude') {
      let mcpConfig: string | undefined;
      if (input.mcp) {
        mcpConfig = path.join(input.agentDir, `mcp-${Date.now()}.json`);
        fs.writeFileSync(mcpConfig, claudeMcpConfig(input.mcp), { mode: 0o600 });
        scratch.push(mcpConfig);
      }
      command = claudeCommandFor(req, { ...opts, ...(mcpConfig ? { mcpConfig } : {}) }, posixShell);
    } else {
      const override = input.mcp ? codexMcpOverride(input.mcp, posixShell.quote) : undefined;
      if (override) env = { ...env, ...override.env };
      command = codexCommandFor(
        req,
        { ...opts, ...(override ? { mcpFlag: override.flag } : {}) },
        posixShell
      );
    }

    let res: CommandResult;
    try {
      res = await this.runner.run(command, {
        cwd: input.cwd,
        env,
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: input.timeoutMs ?? 2 * 60 * 60_000,
      });
    } finally {
      for (const file of scratch) fs.rmSync(file, { force: true });
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
      output: res.stdout.slice(-2_000_000),
    };
  }
}
