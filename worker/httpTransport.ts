import {
  AttachPrRequest,
  AttachPrResponse,
  BlockedRequest,
  CONTRACT_VERSION,
  ClaimRequest,
  ClaimResponse,
  ContractMismatchError,
  HeartbeatRequest,
  HeartbeatResponse,
  PermanentTransportError,
  ProgressRequest,
  RegisterRequest,
  RegisterResponse,
  ReleaseRequest,
  ResultRequest,
  StaleAttemptError,
  TransientTransportError,
} from '../shared/runner/contract';
import { parseAssignment } from '../shared/runner/validate';
import { Feature1Transport } from './transport';

/**
 * The HTTP adapter.
 *
 * EVERY PATH BELOW IS A PROPOSAL. Feature1's execution API does not exist
 * yet, and nothing here has been called against a real server — so the paths
 * are configuration, defaulted to mvpfy's proposed names and overridable
 * without a code change. A worker configured with this transport and pointed
 * at a server that has not implemented them will fail at registration, which
 * is the right place to find out.
 *
 * The adapter's whole job is turning HTTP into the three error kinds the
 * engine knows how to tell apart: stale (never retry, somebody else owns this
 * now), permanent (the server understood and said no), transient (try again).
 */

export interface HttpTransportConfig {
  baseUrl: string;
  runnerToken?: string;
  /** Proposed paths, overridable once the real ones are known. */
  paths?: Partial<Record<keyof Feature1Transport, string>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const PROPOSED_PATHS: Record<keyof Feature1Transport, string> = {
  register: '/api/v1/execution/runners/register',
  heartbeat: '/api/v1/execution/runners/heartbeat',
  claim: '/api/v1/execution/assignments/claim',
  progress: '/api/v1/execution/assignments/progress',
  blocked: '/api/v1/execution/assignments/blocked',
  result: '/api/v1/execution/assignments/result',
  attachPr: '/api/v1/execution/pull-requests/attach',
  release: '/api/v1/execution/assignments/release',
};

/** HTTP statuses that mean the attempt lost its claim. */
const STALE_STATUSES = new Set([409, 412, 423]);

export class HttpFeature1Transport implements Feature1Transport {
  private readonly fetchImpl: typeof fetch;
  private runnerToken: string | undefined;

  constructor(private readonly config: HttpTransportConfig) {
    const base = config.baseUrl.trim();
    // A worker that can be pointed at http:// is a worker whose token can be
    // read off the wire by anything on the path.
    if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
      throw new Error('Feature1 base URL must be https (http is allowed only for localhost)');
    }
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error('No fetch available in this runtime');
    this.runnerToken = config.runnerToken;
  }

  private pathFor(op: keyof Feature1Transport): string {
    return this.config.paths?.[op] ?? PROPOSED_PATHS[op];
  }

  private async post<T>(op: keyof Feature1Transport, body: unknown): Promise<T> {
    const url = new URL(this.pathFor(op), this.config.baseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.runnerToken ? { Authorization: `Bearer ${this.runnerToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // Never reached the server, so the call may not have happened at all.
      throw new TransientTransportError(
        `${op} could not reach Feature1: ${(error as Error).message}`
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    if (STALE_STATUSES.has(res.status)) {
      throw new StaleAttemptError(`${op} refused: this attempt no longer holds the execution`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new PermanentTransportError(`${op} was not authorised by Feature1`, res.status);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new TransientTransportError(`${op} failed with HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new PermanentTransportError(
        `${op} failed with HTTP ${res.status}: ${text.slice(0, 300)}`,
        res.status
      );
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PermanentTransportError(`${op} returned a response that is not JSON`);
    }
  }

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const res = await this.post<RegisterResponse>('register', req);
    if (res?.contractVersion && res.contractVersion !== CONTRACT_VERSION) {
      throw new ContractMismatchError(res.contractVersion);
    }
    this.runnerToken = res?.runnerToken ?? this.runnerToken;
    return res;
  }

  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.post<HeartbeatResponse>('heartbeat', req);
  }

  async claim(req: ClaimRequest): Promise<ClaimResponse> {
    const res = await this.post<{ assignments?: unknown[] }>('claim', req);
    // Parsed here rather than trusted: everything downstream treats an
    // assignment as authority over paths, commands and push targets.
    return { assignments: (res?.assignments ?? []).map(parseAssignment) };
  }

  async progress(req: ProgressRequest): Promise<void> {
    await this.post('progress', req);
  }

  async blocked(req: BlockedRequest): Promise<void> {
    await this.post('blocked', req);
  }

  async result(req: ResultRequest): Promise<void> {
    await this.post('result', req);
  }

  attachPr(req: AttachPrRequest): Promise<AttachPrResponse> {
    return this.post<AttachPrResponse>('attachPr', req);
  }

  async release(req: ReleaseRequest): Promise<void> {
    await this.post('release', req);
  }
}

/** The proposed paths, so the handoff document and tests agree with the code. */
export function proposedPaths(): Record<string, string> {
  return { ...PROPOSED_PATHS };
}
