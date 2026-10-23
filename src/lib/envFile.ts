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

/**
 * Whether the app that is running has actually picked a variable up.
 *
 * The question the editor could never answer. Saving writes to a file;
 * whether the app sees it is a different matter, and every way it does not
 * is silent — the editor says saved, the file has it, and the app behaves
 * exactly as though it was never set. That has cost real hours.
 */
export type EnvStatus = 'live' | 'stale' | 'absent' | 'unknown';

export function envStatusFor(
  key: string,
  fileValue: string,
  running: Record<string, string> | null
): EnvStatus {
  // Nothing running, or docker would not say. Not the same as "absent", and
  // claiming otherwise would send somebody looking for a bug that is not
  // there.
  if (running === null) return 'unknown';
  if (!(key in running)) return 'absent';
  return running[key] === fileValue ? 'live' : 'stale';
}

/**
 * What to say about it, in words a product manager can act on.
 *
 * `absent` is deliberately not called an error. A front end that inlines its
 * API address at build time genuinely has no such variable in its
 * container, and is working perfectly — so the line names both causes
 * rather than picking the alarming one.
 */
export function envStatusLabel(status: EnvStatus): string {
  switch (status) {
    case 'live':
      return 'in use';
    case 'stale':
      return 'saved, not applied';
    case 'absent':
      return 'not in the running app';
    default:
      return '';
  }
}

export function envStatusHint(status: EnvStatus): string {
  switch (status) {
    case 'stale':
      return 'The app is still running with the old value. Restart it to apply this one.';
    case 'absent':
      return (
        'The running app does not have this variable. Either it reads the value when it is ' +
        'built rather than when it starts, or this is not the file it reads.'
      );
    default:
      return '';
  }
}

/** True when anything here is worth drawing the eye to. */
export function envNeedsAttention(statuses: EnvStatus[]): boolean {
  return statuses.some((s) => s === 'stale' || s === 'absent');
}
