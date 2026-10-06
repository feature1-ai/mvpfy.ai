/**
 * How a product decides which customer it is serving, and what that means on a
 * laptop.
 *
 * A product with tenants reads one out of the request: a subdomain
 * (acme.example.com), a path (/acme/orders), or a header. On localhost:4100
 * there is no subdomain, no tenant, and usually no sensible answer — so the
 * app either serves nothing, serves an error about an unknown workspace, or
 * quietly serves a default that behaves unlike any real customer.
 *
 * Sharing already solves one half of this: a tunnel forges the host the demo
 * login says to use. The other half was never addressed, because setting up
 * was never told the product had tenants in the first place. Everything that
 * follows is downstream of writing that down once:
 *
 *   • the proxy in front of the app sends the host the app expects;
 *   • the seeded demo customer is the one that host resolves to;
 *   • a service pointed at an address somewhere else is asked for the same
 *     customer, rather than whatever that server considers the default.
 *
 * The last one is the dangerous one. A remote service is somebody's real
 * environment: asking it for the wrong tenant is reading another customer's
 * data, which is worse than a local app that does not start.
 */

/** Where the product looks to decide whose data this is. */
export type TenancyMode = 'host' | 'path' | 'header' | 'none';

export const TENANCY_LABELS: Record<TenancyMode, string> = {
  host: 'from the web address',
  path: 'from the start of the path',
  header: 'from a request header',
  none: 'single customer — no tenants',
};

export interface Tenancy {
  mode: TenancyMode;
  /**
   * What to be locally: the host for 'host', the first path segment for
   * 'path', the header value for 'header'. Empty when there are no tenants.
   */
  local: string;
  /** The header's name, when the product reads one. */
  header?: string;
}

const MODES = new Set<string>(['host', 'path', 'header', 'none']);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * A tenant value that is safe to put in a header, a hostname and a compose
 * file. Deliberately narrow: this is written into generated configuration and
 * sent to a real server, so anything with a space or a shell's punctuation in
 * it is a mistake, not a tenant.
 */
export function validTenant(value: string | null | undefined): boolean {
  const slug = (value ?? '').trim();
  return slug.length > 0 && slug.length <= 253 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug);
}

export function parseTenancy(raw: string | null | undefined): Tenancy | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = (parsed as { tenancy?: unknown })?.tenancy;
  if (!o || typeof o !== 'object') return null;
  const row = o as Record<string, unknown>;
  const mode = text(row.mode).toLowerCase();
  if (!MODES.has(mode)) return null;
  const header = text(row.header);
  return {
    mode: mode as TenancyMode,
    local: text(row.local),
    ...(header ? { header } : {}),
  };
}

/** True when the product has tenants but nothing says which one to be. */
export function tenancyNeedsAnswer(tenancy: Tenancy | null): boolean {
  return Boolean(tenancy) && tenancy!.mode !== 'none' && !validTenant(tenancy!.local);
}

/** One line a PM can check: who this app thinks it is serving locally. */
export function tenancyLine(tenancy: Tenancy | null): string {
  if (!tenancy || tenancy.mode === 'none') return '';
  const where =
    tenancy.mode === 'host'
      ? 'in the web address'
      : tenancy.mode === 'path'
        ? 'at the start of the path'
        : `in the ${tenancy.header || 'tenant'} header`;
  return validTenant(tenancy.local)
    ? `Your product reads the customer ${where}. Here it runs as ${tenancy.local}.`
    : `Your product reads the customer ${where}, and nothing says which one to be here.`;
}
