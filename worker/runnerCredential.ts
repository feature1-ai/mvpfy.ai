import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The runner credential, kept between starts.
 *
 * A worker used to be given its credential as an environment variable by
 * whoever started it, which is fine for somebody running one by hand and no
 * good for a runner that is set up once and then restarts on its own. Setup
 * (setup.ts) obtains the credential by signing in to Feature1 and leaves it
 * here, on the worker's volume, for every later start to read.
 *
 * Only the runner credential is kept. The personal token that was used to
 * obtain it is not: it can do everything its owner can, and a runner needs
 * none of that.
 */

export interface SavedRunner {
  feature1BaseUrl: string;
  /** 64 hex characters. Authorises claiming and reporting, nothing else. */
  token: string;
  /** ISO time. Feature1 issues these for 24 hours. */
  expiresAt: string;
  /** What Feature1 calls this runner, for the person revoking it. */
  name: string;
}

const FILE = 'runner.json';

function parse(text: string): SavedRunner | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const { feature1BaseUrl, token, expiresAt, name } = raw;
    if (typeof feature1BaseUrl !== 'string' || !feature1BaseUrl) return null;
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null;
    return { feature1BaseUrl, token, expiresAt, name: typeof name === 'string' ? name : '' };
  } catch {
    return null;
  }
}

/** True once the credential can no longer be presented. */
export function isExpired(saved: Pick<SavedRunner, 'expiresAt'>, now: Date = new Date()): boolean {
  return Date.parse(saved.expiresAt) <= now.getTime();
}

/** How long it has left, in words a log line can carry. */
export function timeLeft(saved: Pick<SavedRunner, 'expiresAt'>, now: Date = new Date()): string {
  const minutes = Math.floor((Date.parse(saved.expiresAt) - now.getTime()) / 60_000);
  if (minutes <= 0) return 'expired';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export class RunnerCredentialStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('The worker root must be an absolute path');
  }

  get file(): string {
    return path.join(this.root, FILE);
  }

  /** What setup left, or null when it has not run or the file is not usable. */
  load(): SavedRunner | null {
    try {
      return parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Written whole and then moved into place, readable by this user only. A
   * worker starting while setup is half-way through writing must find either
   * the old credential or the new one.
   */
  save(saved: SavedRunner): void {
    fs.mkdirSync(this.root, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
}
