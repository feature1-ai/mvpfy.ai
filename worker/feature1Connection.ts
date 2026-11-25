import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Feature1 sign-in, kept between starts.
 *
 * The desktop app keeps a person's Feature1 token so it can list and pull
 * their features; a runner that is to do the same has to keep it too. It is
 * the token of whoever ran `setup`, and it can do what they can, so it lives
 * in the secrets directory — which a split deployment mounts in the worker
 * and never in the sandbox — and is given to nothing the worker runs.
 */

export interface SavedConnection {
  feature1BaseUrl: string;
  /** A personal token. Presented to Feature1 by the worker and nobody else. */
  token: string;
  tenant: { id: string; slug: string };
  user: { id: string; email?: string };
}

const FILE = 'feature1.json';

function parse(text: string): SavedConnection | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const tenant = raw.tenant as Record<string, unknown> | undefined;
    const user = raw.user as Record<string, unknown> | undefined;
    if (typeof raw.feature1BaseUrl !== 'string' || !raw.feature1BaseUrl) return null;
    if (typeof raw.token !== 'string' || !raw.token) return null;
    if (typeof tenant?.id !== 'string' || typeof user?.id !== 'string') return null;
    return {
      feature1BaseUrl: raw.feature1BaseUrl,
      token: raw.token,
      tenant: { id: tenant.id, slug: typeof tenant.slug === 'string' ? tenant.slug : '' },
      user: { id: user.id, ...(typeof user.email === 'string' ? { email: user.email } : {}) },
    };
  } catch {
    return null;
  }
}

export class Feature1ConnectionStore {
  constructor(private readonly dir: string) {
    if (!path.isAbsolute(dir)) throw new Error('The secrets directory must be an absolute path');
  }

  get file(): string {
    return path.join(this.dir, FILE);
  }

  load(): SavedConnection | null {
    try {
      return parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Written whole and then moved into place, readable by this user only. */
  save(saved: SavedConnection): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
}
