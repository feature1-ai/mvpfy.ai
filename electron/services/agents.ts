import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_STATE, RunAgentRequest } from '../../shared/types';
import { ensureDirs, isManagedPath, TMP_DIR } from '../paths';
import { startRun } from './runs';
import { shellQuote } from './shell';

/** Spawning of the external coding agents (Claude Code / Codex CLI). */

export function runAgent(req: RunAgentRequest): void {
  const repoPath = path.resolve(req.repoPath);
  if (!isManagedPath(repoPath)) {
    throw new Error(
      'Agent runs are restricted to managed project directories under ~/.mvpfy/projects'
    );
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }
  ensureDirs();
  const promptFile = path.join(TMP_DIR, `prompt-${req.runId}.txt`);
  fs.writeFileSync(promptFile, req.promptText, 'utf8');

  const q = shellQuote;
  let command: string;
  if (req.agent === 'claude') {
    // -p (print) reads the prompt from stdin; stream-json gives per-event
    // output for the live log panel. Permissions are bypassed because the
    // ship-feature flow must run unattended (the PM reviews outputs, not
    // individual tool calls), and the process is confined to the cloned repo.
    command = `cd ${q(repoPath)} && claude -p --verbose --output-format stream-json --dangerously-skip-permissions < ${q(promptFile)}`;
  } else {
    const model = req.model || DEFAULT_STATE.settings.codexModel;
    command = `cd ${q(repoPath)} && codex exec --model ${q(model)} --sandbox danger-full-access --skip-git-repo-check --json - < ${q(promptFile)}`;
  }
  startRun(req.runId, command, repoPath);
}
