import { describe, expect, it } from 'vitest';
import { parseUsage, shortCount, totalIn } from './usage';

// Verbatim from claude 2.x, -p --output-format stream-json. Usage sits under
// `message`, and the final `result` carries the dollar figure.
const CLAUDE = [
  '{"type":"system","subtype":"init","session_id":"abc"}',
  '{"type":"assistant","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":15649,"cache_read_input_tokens":10118,"output_tokens":1}}}',
  '{"type":"assistant","message":{"usage":{"input_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":25767,"output_tokens":120}}}',
  '{"type":"result","usage":{"input_tokens":3,"cache_read_input_tokens":25767,"output_tokens":4},"total_cost_usd":0.161659}',
].join('\n');

// Verbatim from codex-cli 0.153.4, exec --json. Flat, and no cost at all.
const CODEX = [
  '{"type":"thread.started","thread_id":"01a0"}',
  '{"type":"turn.completed","usage":{"input_tokens":14152,"cached_input_tokens":12160,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":5}}',
].join('\n');

describe('parseUsage', () => {
  it('reads Claude Code, where usage hides under message', () => {
    const u = parseUsage(CLAUDE);
    expect(u.turns).toHaveLength(2);
    expect(u.total.output).toBe(121);
    expect(u.total.cacheRead).toBe(35885);
    expect(u.total.cacheWrite).toBe(15649);
  });

  it('does not count the final result as another turn', () => {
    // Whether result repeats the last turn or sums the session is not
    // something the CLI promises. Summing the turns is right either way, and
    // counting it as well would inflate every total.
    expect(parseUsage(CLAUDE).turns).toHaveLength(2);
    expect(parseUsage(CLAUDE).total.input).toBe(5);
  });

  it('reads Codex, which says it flat', () => {
    const u = parseUsage(CODEX);
    expect(u.turns).toHaveLength(1);
    expect(u.total.input).toBe(14152);
    // Reasoning tokens are billed as output and belong in it.
    expect(u.total.output).toBe(15);
    expect(u.total.cacheRead).toBe(12160);
  });

  it('survives a line split across two chunks of streamed output', () => {
    // Output arrives in chunks; a JSON line can be cut in half. Losing that
    // turn's numbers is acceptable, throwing away the run's is not.
    const u = parseUsage(`{"type":"assistant","message":{"usage":{"input_toke\n${CODEX}`);
    expect(u.turns).toHaveLength(1);
    expect(u.total.input).toBe(14152);
  });

  it('says nothing rather than zero for a log with no usage in it', () => {
    const u = parseUsage('$ docker compose up -d\nContainer started');
    expect(u.turns).toEqual([]);
    expect(u.total.input).toBe(0);
  });
});

describe('totalIn', () => {
  it('counts everything the model was sent, however it was billed', () => {
    expect(totalIn({ input: 2, output: 9, cacheRead: 10, cacheWrite: 5 })).toBe(17);
  });
});

describe('shortCount', () => {
  it('stays exact while the number is small enough to mean something', () => {
    expect(shortCount(0)).toBe('0');
    expect(shortCount(999)).toBe('999');
  });

  it('rounds once the digits stop being read', () => {
    expect(shortCount(1234)).toBe('1.2k');
    expect(shortCount(35885)).toBe('36k');
    expect(shortCount(2_400_000)).toBe('2.4M');
  });
});

describe('per-turn detail', () => {
  it('keeps each turn separately, not only the total', () => {
    // The total says what a run consumed; the turns say where it went, and a
    // long run is rarely flat — one turn reading the whole repository can
    // dwarf twenty small ones.
    const u = parseUsage(CLAUDE);
    expect(u.turns.map((t) => t.output)).toEqual([1, 120]);
    expect(u.turns.map((t) => totalIn(t))).toEqual([25769, 25770]);
  });

  it('adds up to the total, so the strip and the header cannot disagree', () => {
    const u = parseUsage(CLAUDE);
    const summed = u.turns.reduce((n, t) => n + totalIn(t) + t.output, 0);
    expect(summed).toBe(totalIn(u.total) + u.total.output);
  });
});
