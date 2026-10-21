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
  /** Shown in Feature1, so a person can tell their workers apart. */
  name: string;
  tenantId: string;
  feature1BaseUrl: string;
  runnerToken?: string;
  /** Absolute. Everything the worker writes lives under it. */
  root: string;
  concurrency: number;
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
  const tenantId = (env.MVPFY_TENANT_ID ?? '').trim();
  if (!tenantId) throw new Error('MVPFY_TENANT_ID is required: a worker serves one tenant');

  const baseUrl = (env.MVPFY_FEATURE1_URL ?? '').trim();
  if (!fake && !baseUrl) {
    throw new Error('MVPFY_FEATURE1_URL is required (or set MVPFY_FAKE_FEATURE1=1 to run offline)');
  }

  const root = (env.MVPFY_WORKER_ROOT ?? '/var/lib/mvpfy').trim();
  if (!root.startsWith('/')) throw new Error('MVPFY_WORKER_ROOT must be an absolute path');

  const agent = (env.MVPFY_AGENT ?? 'claude').trim();
  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error(`MVPFY_AGENT must be claude or codex, not ${JSON.stringify(agent)}`);
  }

  const concurrency = intFrom(env.MVPFY_CONCURRENCY, 1, 'MVPFY_CONCURRENCY');
  // Concurrency is per worker and each execution holds checkouts, an agent
  // and its build. A number somebody typed by accident costs real money.
  if (concurrency > 8) throw new Error('MVPFY_CONCURRENCY above 8 is almost certainly a mistake');

  const model = (env.MVPFY_AGENT_MODEL ?? '').trim();
  return {
    name: (env.MVPFY_WORKER_NAME ?? 'mvpfy worker').trim(),
    tenantId,
    feature1BaseUrl: baseUrl,
    ...(env.MVPFY_RUNNER_TOKEN?.trim() ? { runnerToken: env.MVPFY_RUNNER_TOKEN.trim() } : {}),
    root,
    concurrency,
    claimIntervalMs: intFrom(env.MVPFY_CLAIM_INTERVAL_MS, 15_000, 'MVPFY_CLAIM_INTERVAL_MS'),
    heartbeatIntervalMs: intFrom(
      env.MVPFY_HEARTBEAT_INTERVAL_MS,
      30_000,
      'MVPFY_HEARTBEAT_INTERVAL_MS'
    ),
    agent,
    ...(model ? { agentModel: model } : {}),
    fake,
  };
}

/** Everything that must never appear in a log or a report. */
export function secretsIn(config: WorkerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    config.runnerToken,
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.MVPFY_RUNNER_TOKEN,
  ].filter((value): value is string => Boolean(value && value.trim()));
}
