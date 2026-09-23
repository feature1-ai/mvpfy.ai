import { DemoCredential } from './credentials';

/**
 * The hostname a shared app should be told it was asked for, taken from the
 * demo login the seed wrote.
 *
 * A product with tenants in its address seeds a demo tenant and records the
 * address to reach it at — which is exactly the host a share has to forge, and
 * exactly what the person sharing would otherwise have to know and type.
 *
 * Plain localhost is deliberately not returned, and that is the whole care
 * here. Forcing the host to localhost would be worse than leaving it alone: an
 * app that builds absolute URLs from the host it was asked for would start
 * handing the visitor localhost links, which go nowhere from another machine.
 * Left alone, it sees the tunnel's address and builds links that work.
 */
const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function hostFromDemoLogin(credentials: DemoCredential[]): string {
  for (const credential of credentials) {
    for (const field of credential.fields) {
      if (!/url|address|host/i.test(field.key)) continue;
      const host = hostOf(field.value);
      if (host) return host;
    }
  }
  return '';
}

function hostOf(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const name = url.hostname.toLowerCase();
    // A bare localhost tells the app nothing it would not already assume.
    if (LOCAL.has(name)) return '';
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return '';
  }
}
