import * as os from 'node:os';
import { AgentKind } from './agentRun';
import { SavedRunner, isExpired } from './runnerCredential';

/**
 * Everything the worker needs from its environment.
 *
 * Read once, at start-up, and refused loudly when it is wrong. A worker that
 * starts with a half-configured environment and discovers it an hour later,
 * in the middle of somebody's execution, is worse than one that will not
 * start at all.
 *
 * No credential is read here except the ones the worker must present. There
 * is nothing to configure about what it may be asked to do: that comes from
 * the assignment, and the assignment is checked separately.
 */

export interface WorkerConfig {
  /** This worker's own logs, and what Feature1 calls the runner setup adds. */
  name: string;
  feature1BaseUrl: string;
  /**
   * The runner credential: 64 hex characters, minted by a Feature1
   * organisation admin and valid for 24 hours. The worker does not register
   * itself and cannot renew this; when it expires, somebody mints another.
   */
  runnerToken: string;
  /** Absolute. Everything the worker writes lives under it. */
  root: string;
  claimIntervalMs: number;
  heartbeatIntervalMs: number;
  agent: AgentKind;
  agentModel?: string;
  /** Tries each story gets before the execution fails. 1 means no repair. */
  unitAttempts: number;
  /** Use the in-process fake instead of HTTP. For local development. */
  fake: boolean;
}

function intFrom(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number, not ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * What the arguments ask for: claim work, or sign in once.
 *
 * Anything unrecognised is refused rather than taken as "just run". Somebody
 * who typed `setup --renew`, or mistyped `setup`, would otherwise start a
 * second worker claiming executions against the same volume as the one
 * already running, believing they were signing in.
 */
export function commandFrom(argv: string[]): 'run' | 'setup' {
  const args = argv.slice(2);
  if (args.length === 0) return 'run';
  if (args.length === 1 && args[0] === 'setup') return 'setup';
  throw new Error(
    `Unrecognised argument ${JSON.stringify(args.join(' '))}. The worker takes either ` +
      'no arguments, to claim work, or `setup`, to sign in once.'
  );
}

/** Where the worker keeps everything, which is also where setup leaves its credential. */
export function workerRootFrom(env: NodeJS.ProcessEnv = process.env): string {
  const root = (env.MVPFY_WORKER_ROOT ?? '/var/lib/mvpfy').trim();
  if (!root.startsWith('/')) throw new Error('MVPFY_WORKER_ROOT must be an absolute path');
  return root;
}

/**
 * What this worker calls itself, in its logs and to Feature1.
 *
 * The default carries the host name because this is also the name the runner
 * is registered under, and it is what an organisation admin reads when
 * deciding which runner to revoke. A fixed string gave every runner in a
 * workspace the same one, which is no help at all; in a container the host
 * name is the container's id, which is exactly the thing to go and look at.
 */
export function workerNameFrom(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.MVPFY_WORKER_NAME ?? '').trim();
  if (set) return set;
  const host = (() => {
    try {
      return os.hostname().trim();
    } catch {
      return '';
    }
  })();
  return host && host !== 'localhost' ? `mvpfy worker ${host}` : 'mvpfy worker';
}

/**
 * @param saved What `setup` left on the worker's volume, if it has run. The
 *   environment wins where both speak: an operator who sets a variable has
 *   said what they want, and a file from an earlier setup has not.
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  saved: SavedRunner | null = null,
  now: Date = new Date()
): WorkerConfig {
  const fake = env.MVPFY_FAKE_FEATURE1 === '1';
  const envToken = (env.MVPFY_RUNNER_TOKEN ?? '').trim();
  const baseUrl = (env.MVPFY_FEATURE1_URL ?? '').trim() || (saved?.feature1BaseUrl ?? '');
  if (!fake && !baseUrl) {
    throw new Error(
      'This runner has not been set up. Run it once with `setup` to sign in, or set ' +
        'MVPFY_FEATURE1_URL and MVPFY_RUNNER_TOKEN (MVPFY_FAKE_FEATURE1=1 runs offline)'
    );
  }
  if (!fake && !envToken && saved && isExpired(saved, now)) {
    // Said here rather than discovered as a 401 on the first claim, which
    // reads like an outage.
    throw new Error(
      `The runner credential from setup expired at ${saved.expiresAt}. Run \`setup\` again ` +
        'to renew it'
    );
  }
  const runnerToken = envToken || (saved?.token ?? '');
  // Checked for shape at start-up: Feature1 answers 401 to anything that is
  // not 64 hex characters, and an outage is a worse thing to suspect than a
  // mistyped variable.
  if (!fake && !/^[0-9a-f]{64}$/.test(runnerToken)) {
    throw new Error(
      'MVPFY_RUNNER_TOKEN must be the 64-character runner credential an organisation ' +
        'admin minted with POST /api/implementation-runs/runners/credentials — or leave it ' +
        'unset and run `setup`, which obtains one'
    );
  }
  const root = workerRootFrom(env);

  const agent = (env.MVPFY_AGENT ?? 'claude').trim();
  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error(`MVPFY_AGENT must be claude or codex, not ${JSON.stringify(agent)}`);
  }

  const model = (env.MVPFY_AGENT_MODEL ?? '').trim();
  const heartbeatIntervalMs = intFrom(
    env.MVPFY_HEARTBEAT_INTERVAL_MS,
    45_000,
    'MVPFY_HEARTBEAT_INTERVAL_MS'
  );
  // The lease is three minutes. A heartbeat slower than that loses every
  // long execution to a reclaim, which looks like random failure.
  if (heartbeatIntervalMs > 120_000) {
    throw new Error(
      'MVPFY_HEARTBEAT_INTERVAL_MS must stay well under the three-minute lease; 30000–60000 is right'
    );
  }
  const unitAttempts = intFrom(env.MVPFY_UNIT_ATTEMPTS, 3, 'MVPFY_UNIT_ATTEMPTS');
  // Each one is a whole agent run. Past a handful, a story that cannot pass
  // is not being repaired, it is being paid for.
  if (unitAttempts > 5) throw new Error('MVPFY_UNIT_ATTEMPTS must be between 1 and 5');
  return {
    name: workerNameFrom(env),
    feature1BaseUrl: baseUrl,
    runnerToken,
    root,
    claimIntervalMs: intFrom(env.MVPFY_CLAIM_INTERVAL_MS, 15_000, 'MVPFY_CLAIM_INTERVAL_MS'),
    heartbeatIntervalMs,
    agent,
    ...(model ? { agentModel: model } : {}),
    unitAttempts,
    fake,
  };
}

/** Everything that must never appear in a log or a report. */
export function secretsIn(config: WorkerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    config.runnerToken,
    // The lease token is a per-attempt credential too; the engine remembers it
    // as each execution starts (ExecutionEngine.run), not here.
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.MVPFY_RUNNER_TOKEN,
  ].filter((value): value is string => Boolean(value && value.trim()));
}
