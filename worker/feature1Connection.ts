import * as fs from 'node:fs';
import * as path from 'node:path';
import { Feature1Reader } from './feature1Reader';
import { Feature1Login } from './feature1Login';
import { Feature1Mcp, Feature1McpReader, loadMcpAccess } from './feature1Mcp';

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
  /**
   * Connected through Feature1's MCP server from the web app, not with a
   * personal token: `feature1BaseUrl` is then the MCP endpoint, and `token`
   * the access the host last left beside it, read afresh on every load.
   */
  via?: 'mcp';
  feature1BaseUrl: string;
  /** A personal token. Presented to Feature1 by the worker and nobody else. */
  token: string;
  tenant: { id: string; slug: string };
  user: { id: string; email?: string };
}

const FILE = 'feature1.json';

function parse(text: string, dir: string): SavedConnection | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const tenant = raw.tenant as Record<string, unknown> | undefined;
    const user = raw.user as Record<string, unknown> | undefined;
    if (typeof tenant?.id !== 'string' || typeof user?.id !== 'string') return null;
    if (raw.via === 'mcp') {
      const access = loadMcpAccess(dir);
      if (!access) return null;
      return {
        via: 'mcp',
        feature1BaseUrl: access.mcpUrl,
        token: access.accessToken,
        tenant: { id: tenant.id, slug: typeof tenant.slug === 'string' ? tenant.slug : '' },
        user: { id: user.id, ...(typeof user.email === 'string' ? { email: user.email } : {}) },
      };
    }
    if (typeof raw.feature1BaseUrl !== 'string' || !raw.feature1BaseUrl) return null;
    if (typeof raw.token !== 'string' || !raw.token) return null;
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
      return parse(fs.readFileSync(this.file, 'utf8'), this.dir);
    } catch {
      return null;
    }
  }

  /** Written whole and then moved into place, readable by this user only. */
  save(saved: SavedConnection): void {
    fs.mkdirSync(this.dir, { recursive: true });
    // Through MCP the access is the host's, renewed hourly: never kept here.
    if (saved.via === 'mcp') saved = { ...saved, token: '' };
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
}

/** Reads and notes for a connection, whichever way it was made. */
export function readerFor(connection: SavedConnection): Feature1Reader | Feature1McpReader {
  return connection.via === 'mcp' ? new Feature1McpReader() : new Feature1Reader();
}

/** Whose connection this is, asked of Feature1 itself. */
export async function whoIs(
  connection: SavedConnection
): Promise<{ tenant: { id: string; slug: string }; user: { id: string; email?: string } }> {
  return connection.via === 'mcp'
    ? new Feature1Mcp(connection.feature1BaseUrl, connection.token).whoami()
    : new Feature1Login().verify(connection.feature1BaseUrl, connection.token);
}
