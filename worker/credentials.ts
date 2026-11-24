import { Execution, ExecutionCredentials, McpCredential } from '../shared/runner/contract';

/**
 * Who may act as what, for the execution in hand.
 *
 * A hosted worker starts with one thing, its runner token, and is given the
 * rest by the claim: a GitHub token scoped to that execution's repositories,
 * and read-only MCP access for the agent. A self-hosted worker is given
 * neither and uses the `GH_TOKEN` its operator set. Both arrive here, and
 * nothing else in the worker knows which it was.
 *
 * The split that matters is who each credential reaches. The GitHub token
 * goes to the worker's own git and gh commands and to nothing the agent or a
 * repository's scripts start (childEnv.ts strips it from those). The MCP
 * credential is the reverse: it exists to reach the agent, which is why
 * Feature1 makes it worth nothing beyond reading.
 *
 * Small interfaces on purpose. Git needs to be authorised and has no reason
 * to know an execution exists; the engine opens and closes a session and has
 * no reason to know how git is authorised.
 */

/** Something that authorises a command by adding to its environment. */
export interface CommandAuth {
  apply(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

/** Authorises nothing. What git and gh use when nobody supplied anything. */
export const noAuth: CommandAuth = { apply: (env) => env };

/** The engine's view: one execution's credentials, opened and closed. */
export interface CredentialSession {
  /** Take this execution's credentials. Returns every secret, for redaction. */
  begin(execution: Execution): string[];
  /** A progress response brought newer ones. Returns the new secrets. */
  refresh(credentials: ExecutionCredentials | undefined): string[];
  /** Forget them. Nothing outlives the execution it was issued for. */
  end(): void;
  /** What the agent may connect to, or null when Feature1 issued nothing. */
  agentMcp(): McpCredential | null;
}

/** The variable the git credential helper reads. Never on a command line. */
export const GIT_PASSWORD_ENV = 'MVPFY_GIT_PASSWORD';

/**
 * The https hosts an execution's repositories live on.
 *
 * The token is offered to these and no others, so a redirect, a submodule or
 * a rewritten remote pointing somewhere else is asked for a password it does
 * not get.
 */
export function httpsHosts(execution: Pick<Execution, 'repositories'>): string[] {
  const hosts = new Set<string>();
  for (const repo of execution.repositories) {
    try {
      const url = new URL(repo.url);
      if (url.protocol === 'https:') hosts.add(url.host.toLowerCase());
    } catch {
      // An scp-style ssh URL is not a URL, and takes no token.
    }
  }
  return [...hosts].sort();
}

/**
 * Git configuration carried in the environment, appended to any already
 * there. Environment configuration is read last, so it outranks whatever a
 * repository's own config file says — which matters, because the agent can
 * write that file.
 */
function withGitConfig(
  env: NodeJS.ProcessEnv,
  entries: Array<[key: string, value: string]>
): NodeJS.ProcessEnv {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const out: NodeJS.ProcessEnv = { ...env };
  entries.forEach(([key, value], index) => {
    out[`GIT_CONFIG_KEY_${start + index}`] = key;
    out[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(start + entries.length);
  return out;
}

/**
 * The environment that lets git authenticate over https with a token.
 *
 * A credential helper rather than a URL or a header, for three reasons: the
 * token never appears in a command line or in `.git/config`, it is offered
 * only to the hosts named, and it works unchanged for clone, fetch and push.
 *
 * The first entry empties the helper list. Without it, a helper planted in
 * the repository's config would be consulted too, and git tells every helper
 * the password once it has worked.
 *
 * The rest is the same care from the other side: with a token in the
 * environment, git must not run anything the checkout chose. Hooks and the
 * fsmonitor are both "run this program", so both are turned off, and
 * certificate checking is pinned on so a config file cannot route the token
 * through somebody's proxy. This narrows what a hostile checkout can do; it
 * is not a sandbox, and running the agent as a different user is what
 * closes the rest.
 */
export function gitTokenEnv(
  env: NodeJS.ProcessEnv,
  token: string,
  hosts: string[]
): NodeJS.ProcessEnv {
  const helper =
    `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' ` +
    `"$${GIT_PASSWORD_ENV}"; }; f`;
  const entries: Array<[string, string]> = [
    ['credential.helper', ''],
    ...hosts.map((host): [string, string] => [`credential.https://${host}.helper`, helper]),
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['http.sslVerify', 'true'],
  ];
  return { ...withGitConfig(env, entries), [GIT_PASSWORD_ENV]: token };
}

/** The environment that lets gh act with a token, on github.com or a GHES host. */
export function ghTokenEnv(
  env: NodeJS.ProcessEnv,
  token: string,
  hosts: string[]
): NodeJS.ProcessEnv {
  const enterprise = hosts.some((host) => host !== 'github.com');
  return {
    ...env,
    GH_TOKEN: token,
    // gh reads a different variable for any host that is not github.com.
    ...(enterprise ? { GH_ENTERPRISE_TOKEN: token } : {}),
  };
}

/**
 * The credentials of the execution in flight.
 *
 * One at a time, because the worker runs one execution at a time (worker.ts
 * says why). If that changes, this becomes one session per execution and the
 * engine hands each to its own git — the interfaces above already allow it.
 */
export class ExecutionCredentialSession implements CredentialSession {
  private github: string | null = null;
  private mcp: McpCredential | null = null;
  private hosts: string[] = [];
  private active = false;

  /**
   * @param operatorGithubToken What the operator configured (`GH_TOKEN`),
   *   used when Feature1 issues nothing. A token the claim carries always
   *   wins: the server chose it for exactly these repositories.
   */
  constructor(private readonly operatorGithubToken: string | null = null) {}

  begin(execution: Execution): string[] {
    this.active = true;
    this.hosts = httpsHosts(execution);
    this.github = null;
    this.mcp = null;
    return this.refresh(execution.credentials);
  }

  refresh(credentials: ExecutionCredentials | undefined): string[] {
    if (!this.active || !credentials) return [];
    const secrets: string[] = [];
    if (credentials.github?.token) {
      this.github = credentials.github.token;
      secrets.push(credentials.github.token);
    }
    if (credentials.feature1_mcp?.token) {
      this.mcp = credentials.feature1_mcp;
      secrets.push(credentials.feature1_mcp.token);
    }
    return secrets;
  }

  end(): void {
    this.active = false;
    this.github = null;
    this.mcp = null;
    this.hosts = [];
  }

  agentMcp(): McpCredential | null {
    return this.active ? this.mcp : null;
  }

  private githubToken(): string | null {
    if (!this.active) return null;
    return this.github ?? this.operatorGithubToken;
  }

  /** For the worker's git: clone, fetch and push. */
  readonly git: CommandAuth = {
    apply: (env) => {
      const token = this.githubToken();
      return token ? gitTokenEnv(env, token, this.hosts) : env;
    },
  };

  /** For the worker's gh: finding and opening pull requests. */
  readonly gh: CommandAuth = {
    apply: (env) => {
      const token = this.githubToken();
      return token ? ghTokenEnv(env, token, this.hosts) : env;
    },
  };
}

/** The operator's own GitHub token, if they set one. */
export function operatorGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
  return value || null;
}

/**
 * The token of the GitHub login `setup` made, asked of gh itself.
 *
 * Asked once at start-up and then handed to the worker's own git and gh the
 * same way an operator's `GH_TOKEN` is. The alternative — `gh auth
 * setup-git` — makes gh the credential helper for every git on the machine,
 * which includes the agent's.
 */
export async function ghLoginToken(
  run: (command: string) => Promise<{ code: number | null; stdout: string }>
): Promise<string | null> {
  const result = await run('gh auth token --hostname github.com');
  const token = result.stdout.trim();
  return result.code === 0 && /^[\x21-\x7e]{8,4096}$/.test(token) ? token : null;
}
