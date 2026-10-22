import { AgentKind } from './agentRun';

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
  /** For this worker's own logs. Feature1 names the credential, not us. */
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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const fake = env.MVPFY_FAKE_FEATURE1 === '1';

  const baseUrl = (env.MVPFY_FEATURE1_URL ?? '').trim();
  if (!fake && !baseUrl) {
    throw new Error('MVPFY_FEATURE1_URL is required (or set MVPFY_FAKE_FEATURE1=1 to run offline)');
  }
  const runnerToken = (env.MVPFY_RUNNER_TOKEN ?? '').trim();
  // Checked for shape at start-up: Feature1 answers 401 to anything that is
  // not 64 hex characters, and an outage is a worse thing to suspect than a
  // mistyped variable.
  if (!fake && !/^[0-9a-f]{64}$/.test(runnerToken)) {
    throw new Error(
      'MVPFY_RUNNER_TOKEN must be the 64-character runner credential an organisation ' +
        'admin minted with POST /api/implementation-runs/runners/credentials'
    );
  }

  const root = (env.MVPFY_WORKER_ROOT ?? '/var/lib/mvpfy').trim();
  if (!root.startsWith('/')) throw new Error('MVPFY_WORKER_ROOT must be an absolute path');

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
  return {
    name: (env.MVPFY_WORKER_NAME ?? 'mvpfy worker').trim(),
    feature1BaseUrl: baseUrl,
    runnerToken,
    root,
    claimIntervalMs: intFrom(env.MVPFY_CLAIM_INTERVAL_MS, 15_000, 'MVPFY_CLAIM_INTERVAL_MS'),
    heartbeatIntervalMs,
    agent,
    ...(model ? { agentModel: model } : {}),
    fake,
  };
}

/** Everything that must never appear in a log or a report. */
export function secretsIn(config: WorkerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    config.runnerToken,
    // The lease token is a per-attempt credential too; it is remembered as
    // each execution is claimed, not here.
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.MVPFY_RUNNER_TOKEN,
  ].filter((value): value is string => Boolean(value && value.trim()));
}
