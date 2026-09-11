/**
 * The port a project's stack ACTUALLY publishes.
 *
 * The generated compose file publishes `"${HOST_PORT:-4106}:${PORT:-4105}"` —
 * a variable with a fallback — so the real port depends on the env file, while
 * mvpfy watches whatever mvpfy.yml records. Nothing compared the two, so they
 * could drift apart silently and the app would appear never to start.
 */

/** `${NAME:-default}` and `${NAME}`, resolved against an env file's values. */
export function resolveEnvRefs(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_whole, name: string, fallback?: string) => {
    const set = env[name];
    return set !== undefined && set !== '' ? set : (fallback ?? '');
  });
}

/** Values of a .env file, ignoring comments and blank lines. */
export function parseEnvFile(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2]
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * The first host port the compose file publishes, once its variables are
 * resolved. Null when the file names none, which is not a failure — a stack
 * can publish nothing and still be wrong in other ways.
 */
export function parsePublishedPort(
  composeYml: string | null | undefined,
  envText: string | null | undefined
): number | null {
  if (!composeYml) return null;
  const env = parseEnvFile(envText);
  for (const line of composeYml.split('\n')) {
    // A ports entry, in either the "host:container" or bare-host form.
    const entry = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/);
    if (!entry) continue;
    const resolved = resolveEnvRefs(entry[1], env);
    // Resolve first, then split: `${HOST_PORT:-4106}` contains a colon of its
    // own, so splitting the raw string cuts it in the wrong place.
    const host = resolved.split(':')[0];
    const port = Number(host);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return null;
}
