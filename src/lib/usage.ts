/**
 * What a run cost, read out of the agent's own stream.
 *
 * Runs here are long and unattended, and the only thing anybody could say
 * about what one consumed was that the allowance eventually ran out. Both CLIs
 * report their usage per turn as they go; nothing was reading it.
 *
 * The two say it differently — Claude Code nests usage under `message` on each
 * assistant turn and repeats it on a final `result`; Codex emits a flat
 * `turn.completed` — so both shapes are read and reduced to the same one.
 *
 * Tokens only. Claude Code also reports a dollar figure and Codex reports
 * none, so showing money would mean showing it for one agent and not the
 * other — which reads as one of them being free.
 */
export interface TurnUsage {
  input: number;
  output: number;
  /** Tokens served from cache, which are cheaper and worth seeing apart. */
  cacheRead: number;
  cacheWrite: number;
}

export interface RunUsage {
  turns: TurnUsage[];
  total: TurnUsage;
}

const ZERO: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function parseUsage(log: string | null | undefined): RunUsage {
  const turns: TurnUsage[] = [];

  for (const line of (log ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // A line split across two chunks of streamed output. The next one is
      // still readable, and a missed turn costs a number, not the feature.
      continue;
    }
    const type = String(event.type ?? '');

    // The closing event is deliberately skipped rather than counted as a
    // turn: whether it repeats the last turn's numbers or sums the session is
    // not something either CLI promises, and summing the turns is right either
    // way. Counting both would inflate every total silently.
    if (type === 'result') continue;

    const usage =
      type === 'assistant'
        ? ((event.message as Record<string, unknown>)?.usage as Record<string, unknown>)
        : type === 'turn.completed'
          ? (event.usage as Record<string, unknown>)
          : undefined;
    if (!usage || typeof usage !== 'object') continue;

    turns.push({
      input: num(usage.input_tokens),
      output: num(usage.output_tokens) + num(usage.reasoning_output_tokens),
      cacheRead: num(usage.cache_read_input_tokens) + num(usage.cached_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens) + num(usage.cache_write_input_tokens),
    });
  }

  const total = turns.reduce<TurnUsage>(
    (acc, t) => ({
      input: acc.input + t.input,
      output: acc.output + t.output,
      cacheRead: acc.cacheRead + t.cacheRead,
      cacheWrite: acc.cacheWrite + t.cacheWrite,
    }),
    { ...ZERO }
  );
  return { turns, total };
}

/** Everything the model was sent, however it was billed. */
export function totalIn(u: TurnUsage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** 12_400 → "12.4k". Counts this size are read, not compared digit by digit. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
