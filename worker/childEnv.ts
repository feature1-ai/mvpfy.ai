/**
 * The environment handed to code the worker did not write.
 *
 * The agent runs with its permission checks off, and verification runs the
 * repository's own scripts — a test suite, a postinstall hook, whatever
 * `npm test` reaches. Neither needs the worker's credentials: the worker
 * itself pushes and opens the pull request (git.ts, prs.ts pass their own
 * env), and only the worker talks to Feature1. So those are removed before
 * the command starts, and a script that dumps its environment to the network
 * comes away with nothing that can act as the worker.
 *
 * This is a narrowing, not a sandbox: a process running as the same user can
 * still read the worker's own environment from /proc. Running the agent and
 * the checks somewhere else is what closes that: see sandbox.ts.
 */

/** Credentials only the worker uses: Feature1 and GitHub. */
const WORKER_ONLY = [
  /^MVPFY_/,
  /^GH_TOKEN$/,
  /^GITHUB_TOKEN$/,
  /^GH_ENTERPRISE_TOKEN$/,
  /^GITHUB_ENTERPRISE_TOKEN$/,
  // Where gh keeps the login setup made. Without it the agent's gh is signed out.
  /^GH_CONFIG_DIR$/,
];

/** What the agent itself signs in with — not needed by a repo's checks. */
const AGENT_ONLY = [
  /^ANTHROPIC_API_KEY$/,
  /^ANTHROPIC_AUTH_TOKEN$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^OPENAI_API_KEY$/,
  /^CODEX_API_KEY$/,
  // Where the agents keep the sign-ins setup made. The agent needs these; a
  // repository's own test scripts do not, and for the same reason
  // GH_CONFIG_DIR is in the list above — handing a postinstall hook the path
  // to a credential folder is not something to do by omission. It stays a
  // narrowing, not a boundary: HOME is passed through either way, and the
  // header says why.
  /^CLAUDE_CONFIG_DIR$/,
  /^CODEX_HOME$/,
];

function without(env: NodeJS.ProcessEnv, patterns: RegExp[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!patterns.some((p) => p.test(key.toUpperCase()))) out[key] = value;
  }
  return out;
}

/** For the coding agent: everything but the worker's own credentials. */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return without(env, WORKER_ONLY);
}

/** For a repository's verification commands: no credentials at all. */
export function checkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return without(env, [...WORKER_ONLY, ...AGENT_ONLY]);
}
