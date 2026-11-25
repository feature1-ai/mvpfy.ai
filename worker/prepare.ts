import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentUnit, repairPromptFor } from '../shared/agentUnits';
import { buildSetupPrompt } from '../shared/setupPrompt';
import { buildSetupUnits } from '../shared/setupUnits';
import { QUESTIONS_FILE } from '../shared/types';
import { CheckAccess, failedChecks } from '../shared/unitChecks';
import { UnitDriver, runUnits } from '../shared/unitRunner';
import { AgentKind, AgentRunner } from './agentRun';
import { CommandRunner } from './exec';

/**
 * Setting a product up so it can be started: the desktop app's six setup
 * steps, run in the sandbox against a checkout of the base branch.
 *
 * What it leaves is the run recipe — the compose file, the env files and
 * mvpfy.yml, all under `.mvpfy/` — which `preview` lays over a pull
 * request's branch to start the product from it. It is the same setup the
 * desktop app runs, from the same instructions and checked against the same
 * evidence (shared/setupUnits.ts, shared/unitChecks.ts); only how an agent is
 * run and how a file is reached differ.
 *
 * The recipe is kept on the worker's volume and never committed: it is how
 * mvpfy runs the product, not part of the product.
 */

/** Where a linked project keeps every file setup writes. */
export const RECIPE_DIR = '.mvpfy';
/** The first host port a product's stack is given. It runs in its own engine, so any will do. */
export const RECIPE_BASE_PORT = 4000;
const PORT_BLOCK = 10;

export interface PrepareDeps {
  agent: AgentRunner;
  /** Runs the checks' commands, in the sandbox. */
  checks: CommandRunner;
  /** The environment those commands get: the engine's address and nothing of the worker's. */
  checkEnv: NodeJS.ProcessEnv;
  agentKind: AgentKind;
  agentModel?: string;
  /** The setup instructions template (src/prompts/bootstrap-runtime.txt). */
  template: string;
  log: (message: string) => void;
  signal?: AbortSignal;
}

export type PrepareOutcome =
  | { kind: 'done' }
  | { kind: 'questions'; questions: string[] }
  | { kind: 'failed'; step: string; reason: string };

/** Finished steps, kept so that running prepare again carries on rather than starting over. */
class ProgressFile {
  constructor(private readonly file: string) {}
  private read(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { done?: unknown };
      return Array.isArray(raw.done) ? raw.done.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }
  isDone(unit: AgentUnit): boolean {
    return this.read().includes(unit.id);
  }
  markDone(unit: AgentUnit): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ done: [...this.read(), unit.id] }));
  }
}

function access(checkout: string, runner: CommandRunner, env: NodeJS.ProcessEnv): CheckAccess {
  return {
    read: (relative) => {
      const file = path.resolve(checkout, relative);
      if (!file.startsWith(checkout + path.sep)) return null;
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    run: async (command) => {
      const result = await runner.run(command, { cwd: checkout, env, timeoutMs: 120_000 });
      return { status: result.code, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

/**
 * Run setup in `checkout`. `agentDir` is where the agent's prompt files and
 * questions go, outside the checkout.
 */
export async function prepareCheckout(
  checkout: string,
  agentDir: string,
  progressFile: string,
  deps: PrepareDeps
): Promise<PrepareOutcome> {
  const instructions = buildSetupPrompt(deps.template, {
    project: { mode: 'linked', localPath: checkout, basePort: RECIPE_BASE_PORT },
    regenerate: false,
    onWindows: false,
    portBlock: PORT_BLOCK,
  });
  const units = buildSetupUnits({ mode: 'linked' }, instructions);
  const questionsFile = path.join(checkout, RECIPE_DIR, QUESTIONS_FILE);
  const checks = access(checkout, deps.checks, deps.checkEnv);

  const driver: UnitDriver<AgentUnit, PrepareOutcome> = {
    work: async (unit, attempt) => {
      deps.log(`setup step: ${unit.title} (try ${attempt.number} of ${attempt.of})`);
      const prompt = attempt.failure
        ? repairPromptFor(unit.promptText, {
            failure: attempt.failure,
            attempt: attempt.number,
            of: attempt.of,
          })
        : unit.promptText;
      const outcome = await deps.agent.run({
        kind: deps.agentKind,
        ...(deps.agentModel ? { model: deps.agentModel } : {}),
        prompt,
        cwd: checkout,
        agentDir,
        questionsFile,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      if (outcome.questions.length > 0) {
        return { kind: 'stop', stop: { kind: 'questions', questions: outcome.questions } };
      }
      if (outcome.cancelled || outcome.timedOut) {
        const reason = outcome.cancelled ? 'it was cancelled' : 'the agent ran out of time';
        return { kind: 'stop', stop: { kind: 'failed', step: unit.title, reason } };
      }
      return { kind: 'done' };
    },
    check: async (unit) => {
      const failures = await failedChecks(unit.checks, checks);
      return failures.length === 0
        ? { kind: 'passed' }
        : { kind: 'failed', failure: failures.join('\n') };
    },
  };

  const result = await runUnits(units, driver, new ProgressFile(progressFile), {
    maxAttempts: 3,
  });
  if (result.kind === 'completed') return { kind: 'done' };
  if (result.kind === 'stopped') return result.stop;
  return { kind: 'failed', step: result.unit.title, reason: result.failure };
}

/** Copy the recipe out of a checkout, replacing any kept before. */
export function keepRecipe(checkout: string, recipeDir: string): void {
  const from = path.join(checkout, RECIPE_DIR);
  if (!fs.existsSync(path.join(from, 'mvpfy.yml'))) {
    throw new Error('Setup finished but left no .mvpfy/mvpfy.yml to keep');
  }
  fs.rmSync(recipeDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(recipeDir), { recursive: true });
  fs.cpSync(from, recipeDir, {
    recursive: true,
    // Questions and progress belong to the run that made the recipe.
    filter: (source) => path.basename(source) !== QUESTIONS_FILE,
  });
}

/** Lay a kept recipe over a checkout, as `preview` does before starting it. */
export function applyRecipe(recipeDir: string, checkout: string): void {
  if (!fs.existsSync(path.join(recipeDir, 'mvpfy.yml'))) {
    throw new Error('This project has not been prepared. Run `prepare` first.');
  }
  const into = path.join(checkout, RECIPE_DIR);
  fs.rmSync(into, { recursive: true, force: true });
  fs.cpSync(recipeDir, into, { recursive: true });
}
