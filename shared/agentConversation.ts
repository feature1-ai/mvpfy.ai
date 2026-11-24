/**
 * Reading two things out of a coding agent's output: the conversation it
 * opened, and the complaint it makes when asked to continue one that is not
 * there. Shared because both the window and the main process need them — the
 * window to keep a feature in one conversation, the main process to keep the
 * steps of one job in one (see electron/services/agentUnits.ts).
 */

/**
 * A resume that failed because the conversation was never there.
 *
 * mvpfy records a conversation id when it mints it, not when the conversation
 * is proved to exist — so an opening run that failed early, or was killed,
 * leaves an id behind with nothing behind it. Every later run then asks to
 * resume something that was never started.
 *
 * Told apart from every other failure because it is the one that fixes itself:
 * forget the id, open a new conversation, and the work is unaffected. What is
 * on disk carries everything that mattered.
 */
export function lostConversation(log: string | null | undefined): boolean {
  const text = log ?? '';
  // Claude names the id it could not find; codex calls the stored transcript
  // a rollout. Same situation, and the same repair.
  return (
    /No conversation found with session ID/i.test(text) ||
    /no rollout found for thread id/i.test(text)
  );
}

/**
 * The conversation codex just opened, announced on the first line of its
 * output as `{"type":"thread.started","thread_id":"..."}`.
 *
 * Claude is handed an id before it starts; codex cannot be, so the id has to
 * be read back out. Catching it is the whole reason codex can share one
 * conversation across several runs rather than opening a new one — and
 * reading the product again — for each.
 *
 * Only the head of the log is searched: the line is the first thing codex
 * prints, and this runs on every chunk of a stream that grows to megabytes.
 */
export function codexThreadId(log: string | null | undefined): string | null {
  const head = (log ?? '').slice(0, 4000);
  const match = /"type"\s*:\s*"thread\.started"[^}]*?"thread_id"\s*:\s*"([^"]+)"/.exec(head);
  return match ? match[1] : null;
}
