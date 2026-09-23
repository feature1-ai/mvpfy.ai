import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_STATE, RunAgentMcp, RunAgentRequest } from '../../shared/types';
import { ensureDirs, isAllowedWorkspace, TMP_DIR } from '../paths';
import { startRun } from './runs';
import { cdTo, shellQuote } from './shell';

/** Spawning of the external coding agents (Claude Code / Codex CLI). */

/**
 * Per-run Claude MCP config registering the Feature1 server. Claude reads it
 * via --mcp-config. The bearer token lives in this file (TMP_DIR, 0600),
 * never on the command line, so it is not echoed into the run log.
 */
function writeClaudeMcpConfig(runId: string, mcp: RunAgentMcp): string {
  const file = path.join(TMP_DIR, `mcp-${runId}.json`);
  const config = {
    mcpServers: {
      feature1: {
        type: 'http',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.token}` },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

/** Override just this server for a run, keeping the user's normal Codex home. */
export function codexMcpConfig(mcp: RunAgentMcp): { flag: string; env?: NodeJS.ProcessEnv } {
  if (!mcp.token?.trim()) throw new Error('Feature1 requires a personal bearer token. Reconnect.');
  const tokenSetting = mcp.token ? ', bearer_token_env_var = "MVPFY_FEATURE1_TOKEN"' : '';
  const value = `mcp_servers.feature1={ url = ${JSON.stringify(mcp.url)}${tokenSetting} }`;
  return {
    flag: `-c ${shellQuote(value)} `,
    ...(mcp.token ? { env: { MVPFY_FEATURE1_TOKEN: mcp.token } } : {}),
  };
}

/** Per-run scratch that must not outlive the run. */
const RUN_ARTIFACT = /^(prompt-|mcp-|codex-home-)/;

/**
 * Delete per-run scratch left behind by a crash or a force-quit. Some of it
 * holds credentials — a Feature1 bearer token, a copy of the user's Codex
 * sign-in — so it is swept on every launch rather than left to accumulate.
 * Anything younger than an hour is left alone: a run may still be using it.
 */
export function sweepRunArtifacts(maxAgeMs = 60 * 60_000, dir: string = TMP_DIR): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!RUN_ARTIFACT.test(entry.name)) continue;
    const target = path.join(dir, entry.name);
    try {
      if (fs.statSync(target).mtimeMs > cutoff) continue;
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort — a file we cannot remove is not worth failing a launch.
    }
  }
}

export function removeQuietly(targets: string[]): void {
  for (const target of targets) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort; sweepRunArtifacts catches it on the next launch.
    }
  }
}

/**
 * The claude invocation for one run. Pure and exported so the flag assembly —
 * three optional flags whose order matters to the CLI — can be tested without
 * spawning anything.
 */
export function claudeCommandFor(
  req: Pick<RunAgentRequest, 'model' | 'session'>,
  opts: { repoPath: string; promptFile: string; mcpConfig?: string }
): string {
  const q = shellQuote;
  const mcpFlag = opts.mcpConfig ? `--mcp-config ${q(opts.mcpConfig)} ` : '';
  // No --model unless one was chosen: claude then uses the model the user has
  // already configured, which never goes stale as the models change.
  const modelFlag = req.model ? `--model ${q(req.model)} ` : '';
  // --session-id names the conversation on the run that opens it; --resume
  // continues it. mvpfy chooses the id, so the two always agree.
  const sessionFlag = req.session
    ? req.session.resume
      ? `--resume ${q(req.session.id)} `
      : `--session-id ${q(req.session.id)} `
    : '';
  return (
    `${cdTo(opts.repoPath)} && claude ${mcpFlag}${modelFlag}${sessionFlag}` +
    `-p --verbose --output-format stream-json --dangerously-skip-permissions ` +
    `< ${q(opts.promptFile)}`
  );
}

export function runAgent(req: RunAgentRequest): void {
  const repoPath = path.resolve(req.repoPath);
  if (!isAllowedWorkspace(repoPath)) {
    throw new Error(
      'Agent runs are restricted to managed project directories and linked project folders'
    );
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }
  spawnAgentRun(req, repoPath);
}

/**
 * An agent run that belongs to no project: installing the tools mvpfy itself
 * needs, before there is a project to install them for.
 *
 * The workspace guard exists to keep agent runs inside directories mvpfy owns
 * or the user linked, and it still does — this runs in mvpfy's own scratch
 * directory, with a prompt mvpfy wrote, from a button that does one thing. The
 * agent is installing software on the machine either way; the working
 * directory is not what makes that safe or unsafe, and pointing it at somebody
 * else's project to satisfy a check would be worse than saying so here.
 */
export function runToolingAgent(req: RunAgentRequest): void {
  ensureDirs();
  spawnAgentRun(req, TMP_DIR);
}

function spawnAgentRun(req: RunAgentRequest, repoPath: string): void {
  if (req.mcp && !req.mcp.token?.trim())
    throw new Error('Feature1 requires a personal bearer token. Reconnect.');
  ensureDirs();
  const promptFile = path.join(TMP_DIR, `prompt-${req.runId}.txt`);
  fs.writeFileSync(promptFile, req.promptText, 'utf8');
  // Everything written for this run only, removed when it ends.
  const scratch: string[] = [promptFile];

  const q = shellQuote;
  let command: string;
  let env: NodeJS.ProcessEnv | undefined;
  if (req.agent === 'claude') {
    // -p (print) reads the prompt from stdin; stream-json gives per-event
    // output for the live log panel. Permissions are bypassed because the
    // ship-feature flow must run unattended (the PM reviews outputs, not
    // individual tool calls), and the process is confined to the cloned repo.
    // --mcp-config registers the Feature1 server for this run only.
    // Feature1 runs always carry their own token; never rely on a global
    // agent registration or another client’s server-side login.
    const needsMcpConfig = Boolean(req.mcp?.token);
    if (needsMcpConfig) scratch.push(writeClaudeMcpConfig(req.runId, req.mcp!));
    command = claudeCommandFor(req, {
      repoPath,
      promptFile,
      mcpConfig: needsMcpConfig ? scratch[scratch.length - 1] : undefined,
    });
  } else {
    // No model named means codex uses its own configured one, which is the
    // only choice that cannot be wrong about somebody else's account.
    const model = (req.model || DEFAULT_STATE.settings.codexModel).trim();
    const modelFlag = model ? `--model ${q(model)} ` : '';
    const mcpConfig = req.mcp ? codexMcpConfig(req.mcp) : undefined;
    env = mcpConfig?.env;
    // Codex attaches images to the prompt rather than opening them from a
    // path, so a design has to be handed over as arguments. The prompt names
    // the same files regardless, which is what Claude Code reads.
    const imageFlags = (req.images ?? []).map((f) => `--image ${q(f)} `).join('');
    command = `${cdTo(repoPath)} && codex exec ${mcpConfig?.flag ?? ''}${imageFlags}${modelFlag}--sandbox danger-full-access --skip-git-repo-check --json - < ${q(promptFile)}`;
  }
  startRun(req.runId, command, repoPath, () => removeQuietly(scratch), env);
}
