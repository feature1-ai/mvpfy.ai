import {
  AttachPrRequest,
  AttachPrResponse,
  BlockedRequest,
  ClaimRequest,
  ClaimResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  ProgressRequest,
  RegisterRequest,
  RegisterResponse,
  ReleaseRequest,
  ResultRequest,
} from '../shared/runner/contract';

/**
 * Everything the worker says to Feature1, behind one interface.
 *
 * It is an interface rather than a module of functions because no real
 * endpoint has been confirmed: the whole worker is developed and tested
 * against `FakeFeature1`, and the HTTP adapter is a thin thing that can be
 * rewritten in an afternoon once the real API exists. Nothing above this
 * line knows whether it is talking to a server or to a fake.
 */
export interface Feature1Transport {
  register(req: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  claim(req: ClaimRequest): Promise<ClaimResponse>;
  progress(req: ProgressRequest): Promise<void>;
  blocked(req: BlockedRequest): Promise<void>;
  result(req: ResultRequest): Promise<void>;
  attachPr(req: AttachPrRequest): Promise<AttachPrResponse>;
  release(req: ReleaseRequest): Promise<void>;
}

/**
 * Try something that may have failed for a reason that will pass.
 *
 * `StaleAttemptError` and `PermanentTransportError` are never retried: the
 * first means somebody else owns this execution now, and retrying it is how
 * two workers end up both reporting; the second means the server understood
 * and said no.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  opts: {
    attempts?: number;
    /** Called with the delay before each wait, so tests need no clock. */
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number) => void;
  } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'StaleAttemptError' || name === 'PermanentTransportError') throw error;
      lastError = error;
      if (attempt === attempts) break;
      opts.onRetry?.(error, attempt);
      await sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
