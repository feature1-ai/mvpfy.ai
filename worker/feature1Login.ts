/**
 * Signing a runner in to Feature1, the way a person signs the desktop app in.
 *
 * The desktop app takes a workspace address and a personal token and checks
 * the two against `/api/auth/me` before believing either (docs/
 * feature1-connection.md). Setup does the same, then does the one thing the
 * token is wanted for: it asks Feature1 for a runner credential. That
 * request only succeeds for an organisation admin, which is the right
 * person to be adding a runner.
 *
 * Nothing here keeps the personal token. It is used for two requests and
 * dropped.
 */

export class Feature1LoginError extends Error {}

export interface Feature1Identity {
  tenant: { id: string; slug: string };
  user: { id: string; email?: string };
}

export interface MintedRunner {
  token: string;
  expiresAt: string;
}

/**
 * The workspace address, checked before a token is sent to it. https, with
 * plain http allowed only for a Feature1 on this machine.
 */
export function workspaceBaseUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Feature1LoginError(`That is not a web address: ${JSON.stringify(input)}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Feature1LoginError('The Feature1 workspace address must start with https://');
  }
  if (url.username || url.password) {
    throw new Feature1LoginError('The workspace address must not contain a user name or password');
  }
  return url.origin;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class Feature1Login {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  private async request(url: string, token: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Feature1LoginError(
        `Feature1 could not be reached at ${new URL(url).origin}: ${(error as Error).message}`
      );
    }
  }

  /** Whose token this is, according to the workspace it was given for. */
  async verify(baseUrl: string, token: string): Promise<Feature1Identity> {
    const res = await this.request(`${baseUrl}/api/auth/me`, token);
    if (res.status === 401 || res.status === 403) {
      throw new Feature1LoginError(
        'Feature1 rejected that token. Check it is yours and belongs to this workspace.'
      );
    }
    if (!res.ok) {
      throw new Feature1LoginError(`Feature1 answered ${res.status} when asked who the token is`);
    }
    const body = await json(res);
    const tenant = body.tenant as Feature1Identity['tenant'] | undefined;
    const user = body.user as Feature1Identity['user'] | undefined;
    if (!tenant?.id || !user?.id) {
      throw new Feature1LoginError('Feature1 did not say which workspace and person the token is');
    }
    return { tenant, user };
  }

  /** A runner credential for this workspace. Organisation admins only. */
  async mintRunner(baseUrl: string, token: string, name: string): Promise<MintedRunner> {
    const res = await this.request(
      `${baseUrl}/api/implementation-runs/runners/credentials`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({ name }),
      }
    );
    const body = await json(res);
    if (res.status === 404) {
      throw new Feature1LoginError(
        'This Feature1 workspace does not have mvpfy implementation turned on ' +
          '(MVPFY_IMPLEMENTATION_ENABLED). Nothing was changed.'
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Feature1LoginError(
        'Only an organisation admin can add a runner. Sign in as one, or ask one to run setup.'
      );
    }
    const credential = body.credential as { token?: unknown; expires_at?: unknown } | undefined;
    if (!res.ok || !credential) {
      const reason = typeof body.error === 'string' ? `: ${body.error}` : '';
      throw new Feature1LoginError(`Feature1 would not issue a runner credential${reason}`);
    }
    const minted = String(credential.token ?? '');
    const expires = new Date(String(credential.expires_at ?? ''));
    if (!/^[0-9a-f]{64}$/.test(minted) || Number.isNaN(expires.getTime())) {
      throw new Feature1LoginError(
        'Feature1 issued a runner credential in a form mvpfy does not know'
      );
    }
    return { token: minted, expiresAt: expires.toISOString() };
  }
}
