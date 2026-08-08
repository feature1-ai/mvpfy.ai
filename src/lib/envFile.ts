export interface EnvEntry {
  key: string;
  value: string;
}

/** Files the env editor looks for at the workspace root, in priority order. */
export const ENV_FILE_CANDIDATES = ['.env.mvpfy', '.env', '.env.local'] as const;

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Parse KEY=VALUE lines (comments and blanks skipped), preserving order. */
export function parseEnv(content: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const line of content.split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) out.push({ key: m[1], value: stripQuotes(m[2].trim()) });
  }
  return out;
}

/**
 * Write entries back into the original content: known keys are updated
 * in place (comments and unknown lines untouched), new keys are appended.
 */
export function updateEnv(content: string, entries: EnvEntry[]): string {
  const byKey = new Map(entries.map((e) => [e.key, e.value]));
  const seen = new Set<string>();
  const lines = content.split('\n').map((line) => {
    const m = LINE_RE.exec(line);
    if (!m || !byKey.has(m[1])) return line;
    seen.add(m[1]);
    return `${m[1]}=${quoteIfNeeded(byKey.get(m[1])!)}`;
  });
  const appended = entries
    .filter((e) => !seen.has(e.key))
    .map((e) => `${e.key}=${quoteIfNeeded(e.value)}`);
  let result = lines.join('\n');
  if (appended.length > 0) {
    if (result.length > 0 && !result.endsWith('\n')) result += '\n';
    result += appended.join('\n') + '\n';
  }
  return result;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteIfNeeded(value: string): string {
  return /[\s#]/.test(value) ? `"${value}"` : value;
}
