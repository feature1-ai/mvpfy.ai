/**
 * What the agent is doing right now, in the PM's words.
 *
 * The run log is newline-delimited JSON from the agent CLI. Setting a project
 * up starts with a phase that writes the task list, and until that file lands
 * there are no cards to watch — a minute of a spinner and nothing else. This
 * reads the tail of the stream so there is always something true to show.
 */

function baseName(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return 'a file';
  return text.split(/[/\\]/).filter(Boolean).pop() ?? 'a file';
}

/** Tools worth naming; anything else is described by its own name. */
const TOOL_PHRASE: Record<string, (input: Record<string, unknown>) => string> = {
  Read: (i) => `Reading ${baseName(i.file_path)}`,
  Write: (i) => `Writing ${baseName(i.file_path)}`,
  Edit: (i) => `Editing ${baseName(i.file_path)}`,
  MultiEdit: (i) => `Editing ${baseName(i.file_path)}`,
  NotebookEdit: (i) => `Editing ${baseName(i.notebook_path)}`,
  Bash: (i) => (i.description ? String(i.description) : 'Running a command'),
  Glob: () => 'Looking through the files',
  Grep: () => 'Searching the code',
  LS: () => 'Looking through the files',
  WebFetch: () => 'Reading documentation',
  WebSearch: () => 'Searching the web',
  TodoWrite: () => 'Updating its checklist',
  Task: () => 'Working on a sub-task',
};

/** First sentence of a thought, short enough to sit on one line. */
function firstSentence(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return sentence.length > 100 ? `${sentence.slice(0, 99)}…` : sentence;
}

function fromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  // Last block first: the newest thing in the message is the current one.
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as Record<string, unknown> | null;
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      const input = (block.input ?? {}) as Record<string, unknown>;
      const phrase = TOOL_PHRASE[block.name];
      return phrase ? phrase(input) : `Using ${block.name}`;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const sentence = firstSentence(block.text);
      if (sentence) return sentence;
    }
  }
  return null;
}

/**
 * The most recent describable step, or null when the stream has not said
 * anything usable yet. Reads backwards and stops at the first hit, so a long
 * log costs no more than a short one.
 */
export function latestActivity(log: string): string | null {
  const lines = log.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // A partially written line, or plain output.
    }
    // A finished run is not an activity — the caller shows the outcome.
    if (event.type === 'result') return null;
    const message = event.message as Record<string, unknown> | undefined;
    const found =
      fromContent(message?.content) ??
      fromContent(event.content) ??
      // Codex nests its items one level down under a different name.
      fromContent((event.item as Record<string, unknown> | undefined)?.content);
    if (found) return found;
  }
  return null;
}
