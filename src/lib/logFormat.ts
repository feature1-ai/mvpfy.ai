/**
 * Pretty-print the JSONL event streams emitted by `claude -p --output-format
 * stream-json` and `codex exec --json`. Unknown or non-JSON lines pass through
 * unchanged, so plain-text output (git, docker) still reads normally.
 */

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const hint = obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url;
    if (typeof hint === 'string') return hint.length > 120 ? `${hint.slice(0, 120)}…` : hint;
  }
  return '';
}

function formatClaudeEvent(ev: Record<string, unknown>): string | null {
  if (ev.type === 'system' && ev.subtype === 'init') {
    return `▸ claude session started (${String(ev.model ?? 'unknown model')})`;
  }
  if (ev.type === 'assistant' || ev.type === 'user') {
    const message = ev.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const lines: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lines.push(block.text.trim());
      } else if (block.type === 'tool_use') {
        const hint = summarizeToolInput(block.input);
        lines.push(`→ ${String(block.name)}${hint ? `: ${hint}` : ''}`);
      }
      // tool_result blocks are omitted: they are large and the agent's own
      // narration already covers the outcome.
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
  if (ev.type === 'result') {
    const status = ev.is_error ? '✗ finished with error' : '✔ finished';
    const result = typeof ev.result === 'string' ? `\n${ev.result.trim()}` : '';
    return `${status}${result}`;
  }
  return null;
}

function formatCodexEvent(ev: Record<string, unknown>): string | null {
  // codex exec --json emits {type: "item.completed", item: {...}} events and
  // legacy {msg: {type: ...}} events depending on version.
  const item = ev.item as Record<string, unknown> | undefined;
  if (item) {
    if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
    if (typeof item.command === 'string') return `→ ${item.command}`;
    return null;
  }
  const msg = ev.msg as Record<string, unknown> | undefined;
  if (msg) {
    if (typeof msg.message === 'string') return msg.message;
    if (typeof msg.command === 'string') return `→ ${String(msg.command)}`;
    return null;
  }
  return null;
}

export function formatLogLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return line;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return line;
  }
  const formatted = formatClaudeEvent(ev) ?? formatCodexEvent(ev);
  // null → drop the line (noise like tool results / partial deltas).
  return formatted;
}

/** Format a full log buffer; the final partial line is passed through as-is. */
export function formatLog(raw: string): string {
  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  const partial = endsWithNewline ? null : (lines.pop() ?? null);
  const out: string[] = [];
  for (const line of lines) {
    if (line === '') continue;
    const formatted = formatLogLine(line);
    if (formatted !== null) out.push(formatted);
  }
  if (partial && !partial.trim().startsWith('{')) out.push(partial);
  return out.join('\n');
}
