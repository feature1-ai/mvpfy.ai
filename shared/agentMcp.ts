/**
 * How a coding agent is handed the Feature1 MCP server for one run.
 *
 * Shared for the same reason the command builders are: the desktop app and
 * the headless worker both register the server per run, and the two CLIs
 * disagree about how — Claude Code reads a config file, Codex takes an
 * override flag and reads the token from an environment variable. Two copies
 * of that would drift the first time either CLI changed.
 *
 * Pure. Writing the file and choosing where it lives is the caller's job,
 * because a desktop temp directory and a worker's execution directory are
 * different places with different lifetimes.
 */

export interface AgentMcpServer {
  url: string;
  token: string;
}

/** The name the agents know the server by; tool names derive from it. */
export const FEATURE1_MCP_NAME = 'feature1';

/** The variable Codex reads the bearer token from. Never on a command line. */
export const CODEX_MCP_TOKEN_ENV = 'MVPFY_FEATURE1_TOKEN';

/**
 * The file Claude Code reads through `--mcp-config`.
 *
 * The token lives in the file rather than in a flag so it is not echoed into
 * a process list or a run log. Write it 0600 and delete it after the run.
 */
export function claudeMcpConfig(mcp: AgentMcpServer): string {
  return JSON.stringify({
    mcpServers: {
      [FEATURE1_MCP_NAME]: {
        type: 'http',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.token}` },
      },
    },
  });
}

/**
 * The override Codex takes for one run, leaving its own home untouched.
 *
 * The flag names the variable, and the variable carries the token, so the
 * token is in the environment of that one process and nowhere else.
 */
export function codexMcpOverride(
  mcp: AgentMcpServer,
  quote: (value: string) => string
): { flag: string; env: Record<string, string> } {
  const value =
    `mcp_servers.${FEATURE1_MCP_NAME}={ url = ${JSON.stringify(mcp.url)}, ` +
    `bearer_token_env_var = "${CODEX_MCP_TOKEN_ENV}" }`;
  return { flag: `-c ${quote(value)} `, env: { [CODEX_MCP_TOKEN_ENV]: mcp.token } };
}
