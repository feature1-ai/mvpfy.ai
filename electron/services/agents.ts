import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_STATE, RunAgentMcp, RunAgentRequest } from '../../shared/types';
import { ensureDirs, isAllowedWorkspace, TMP_DIR } from '../paths';
import { startRun } from './runs';
import { shellQuote } from './shell';

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

/**
 * Codex has no --mcp-config flag; it reads $CODEX_HOME/config.toml. Build a
 * per-run CODEX_HOME that copies the user's real ~/.codex (to keep their
 * sign-in) and appends the Feature1 MCP server, so the run is self-contained
 * and the user's global config is never mutated.
 */
function prepareCodexHome(runId: string, mcp: RunAgentMcp): string {
  const dir = path.join(TMP_DIR, `codex-home-${runId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realHome = path.join(os.homedir(), '.codex');
  if (fs.existsSync(realHome)) {
    fs.cpSync(realHome, dir, { recursive: true });
  }
  const configPath = path.join(dir, 'config.toml');
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  // Streamable-HTTP MCP server entry; auth carried as an Authorization
  // header. (Codex HTTP-MCP config may need verification on the target host.)
  const block = [
    '',
    '[mcp_servers.feature1]',
    `url = "${mcp.url}"`,
    `http_headers = { "Authorization" = "Bearer ${mcp.token}" }`,
    '',
  ].join('\n');
  fs.writeFileSync(configPath, existing + block, { mode: 0o600 });
  return dir;
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

function removeQuietly(targets: string[]): void {
  for (const target of targets) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort; sweepRunArtifacts catches it on the next launch.
    }
  }
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
  ensureDirs();
  const promptFile = path.join(TMP_DIR, `prompt-${req.runId}.txt`);
  fs.writeFileSync(promptFile, req.promptText, 'utf8');
  // Everything written for this run only, removed when it ends.
  const scratch: string[] = [promptFile];

  const q = shellQuote;
  let command: string;
  if (req.agent === 'claude') {
    // -p (print) reads the prompt from stdin; stream-json gives per-event
    // output for the live log panel. Permissions are bypassed because the
    // ship-feature flow must run unattended (the PM reviews outputs, not
    // individual tool calls), and the process is confined to the cloned repo.
    // --mcp-config registers the Feature1 server for this run only.
    if (req.mcp) scratch.push(writeClaudeMcpConfig(req.runId, req.mcp));
    const mcpFlag = req.mcp ? `--mcp-config ${q(scratch[scratch.length - 1])} ` : '';
    command = `cd ${q(repoPath)} && claude ${mcpFlag}-p --verbose --output-format stream-json --dangerously-skip-permissions < ${q(promptFile)}`;
  } else {
    const model = req.model || DEFAULT_STATE.settings.codexModel;
    if (req.mcp) scratch.push(prepareCodexHome(req.runId, req.mcp));
    const codexHomeEnv = req.mcp ? `CODEX_HOME=${q(scratch[scratch.length - 1])} ` : '';
    command = `cd ${q(repoPath)} && ${codexHomeEnv}codex exec --model ${q(model)} --sandbox danger-full-access --skip-git-repo-check --json - < ${q(promptFile)}`;
  }
  startRun(req.runId, command, repoPath, () => removeQuietly(scratch));
}
