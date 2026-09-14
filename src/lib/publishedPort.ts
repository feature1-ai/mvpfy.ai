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
 * Every host port the compose file publishes, once its variables are resolved.
 *
 * Only entries under a `ports:` key count. Scanning every list item in the file
 * matched the first number anywhere — in a stack of several services that is
 * usually the database, not the app, so the two ports never agreed and the
 * mismatch warning stayed up forever however often the stack was rebuilt.
 */
export function parsePublishedPorts(
  composeYml: string | null | undefined,
  envText: string | null | undefined
): number[] {
  if (!composeYml) return [];
  const env = parseEnvFile(envText);
  const ports: number[] = [];
  let blockIndent: number | null = null;
  for (const line of composeYml.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (/^\s*ports:\s*$/.test(line)) {
      blockIndent = indent;
      continue;
    }
    if (blockIndent === null) continue;
    const entry = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/);
    // Any other key at or above the ports: key's own indentation closes it.
    if (!entry) {
      if (indent <= blockIndent) blockIndent = null;
      continue;
    }
    // Resolve first, then split: `${HOST_PORT:-4106}` contains a colon of its
    // own, so splitting the raw string cuts it in the wrong place.
    const resolved = resolveEnvRefs(entry[1], env);
    const parts = resolved.split(':');
    // "8080" publishes nothing to the host — docker picks a random port. Only
    // "host:container" pins one, so a bare entry is not a host port at all.
    if (parts.length < 2) continue;
    // "127.0.0.1:8080:80" — the host port is the part before the container's.
    const port = Number(parts[parts.length - 2]);
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
  }
  return [...new Set(ports)];
}

/**
 * The first host port the compose file publishes. Null when the file names
 * none, which is not a failure — a stack can publish nothing and still be
 * wrong in other ways.
 */
export function parsePublishedPort(
  composeYml: string | null | undefined,
  envText: string | null | undefined
): number | null {
  return parsePublishedPorts(composeYml, envText)[0] ?? null;
}
