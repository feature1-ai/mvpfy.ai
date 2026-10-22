import {
  Execution,
  PermanentTransportError,
  ProgressBody,
  ProgressResponse,
  StaleAttemptError,
  TransientTransportError,
} from '../shared/runner/contract';
import { parseExecution } from '../shared/runner/validate';
import { Feature1Transport } from './transport';

/**
 * Feature1's execution API over HTTP.
 *
 * These paths are no longer a proposal: they are what
 * `backend/routes/implementation-runs.js` mounts, and they are reachable
 * only when the server has `MVPFY_IMPLEMENTATION_ENABLED=true` — without it
 * every one of them answers 404, which is worth knowing before blaming the
 * credential.
 *
 * The adapter's whole job is turning HTTP into the three error kinds the
 * engine tells apart: stale (stop, never retry), permanent (the server
 * understood and refused), transient (try again).
 */

export const CLAIM_PATH = '/api/implementation-runs/worker/claim';
export const progressPath = (executionId: string): string =>
  `/api/implementation-runs/worker/${encodeURIComponent(executionId)}/progress`;

export interface HttpTransportConfig {
  baseUrl: string;
  /** The runner credential: 64 hex characters, minted by an org admin. */
  runnerToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpFeature1Transport implements Feature1Transport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: HttpTransportConfig) {
    const base = config.baseUrl.trim();
    // The credential travels on every request.
    if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
      throw new Error('Feature1 base URL must be https (http is allowed only for localhost)');
    }
    // Checked here so a mistyped credential fails at start-up rather than
    // looking like an outage on the first claim.
    if (!/^[0-9a-f]{64}$/.test(config.runnerToken.trim())) {
      throw new Error('The runner credential must be 64 hexadecimal characters');
    }
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error('No fetch available in this runtime');
  }

  private async post<T>(
    what: string,
    path: string,
    body: unknown,
    leaseToken?: string
  ): Promise<T> {
    const url = new URL(path, this.config.baseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.runnerToken}`,
          // The lease is a header, never a body field: it is a credential
          // for this attempt and has no business in a payload that might be
          // logged or echoed back.
          ...(leaseToken ? { 'X-Execution-Lease': leaseToken } : {}),
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      // Never reached the server, so the call may not have happened at all.
      throw new TransientTransportError(
        `${what} could not reach Feature1: ${(error as Error).message}`
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    // 409 is the server saying this attempt no longer holds the execution.
    if (res.status === 409) {
      throw new StaleAttemptError(readError(text) ?? 'Lease expired or superseded');
    }
    if (res.status === 401 || res.status === 403) {
      throw new PermanentTransportError(
        `${what} was refused: ${readError(text) ?? 'the runner credential was rejected'}`,
        res.status
      );
    }
    if (res.status === 404) {
      // Either the execution is gone or the feature flag is off, and the
      // difference matters enough to say out loud.
      throw new PermanentTransportError(
        `${what} returned 404 — the execution is gone, or Feature1 does not have ` +
          `MVPFY_IMPLEMENTATION_ENABLED turned on`,
        404
      );
    }
    if (res.status >= 500 || res.status === 429) {
      throw new TransientTransportError(`${what} failed with HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new PermanentTransportError(
        `${what} failed with HTTP ${res.status}: ${readError(text) ?? text.slice(0, 300)}`,
        res.status
      );
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PermanentTransportError(`${what} returned a response that is not JSON`);
    }
  }

  async claim(): Promise<Execution | null> {
    const res = await this.post<{ execution?: unknown }>('claim', CLAIM_PATH, {});
    if (!res?.execution) return null;
    // Parsed rather than trusted: it decides what gets cloned and pushed.
    return parseExecution(res.execution);
  }

  async progress(
    executionId: string,
    leaseToken: string,
    body: ProgressBody
  ): Promise<ProgressResponse['execution']> {
    const res = await this.post<{ execution?: ProgressResponse['execution'] }>(
      'progress',
      progressPath(executionId),
      body,
      leaseToken
    );
    return (res?.execution ?? {}) as ProgressResponse['execution'];
  }
}

/** Feature1 answers `{success:false,error:"..."}`; surface the sentence. */
function readError(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}
