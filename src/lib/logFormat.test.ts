import { describe, expect, it } from 'vitest';
import { formatLog, formatLogLine } from './logFormat';

describe('formatLogLine', () => {
  it('passes plain text through unchanged', () => {
    expect(formatLogLine('Cloning into repo...')).toBe('Cloning into repo...');
  });

  it('formats claude session init', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' });
    expect(formatLogLine(line)).toBe('▸ claude session started (claude-fable-5)');
  });

  it('formats assistant text and tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running tests now.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    });
    expect(formatLogLine(line)).toBe('Running tests now.\n→ Bash: npm test');
  });

  it('formats the final result event', () => {
    const ok = JSON.stringify({ type: 'result', is_error: false, result: 'done' });
    expect(formatLogLine(ok)).toBe('✔ finished\ndone');
    const err = JSON.stringify({ type: 'result', is_error: true });
    expect(formatLogLine(err)).toBe('✗ finished with error');
  });

  it('drops unknown JSON events instead of showing raw JSON', () => {
    expect(formatLogLine(JSON.stringify({ type: 'rate_limit_event' }))).toBeNull();
  });

  it('formats codex item events', () => {
    const line = JSON.stringify({ type: 'item.completed', item: { text: 'Implemented AC-1' } });
    expect(formatLogLine(line)).toBe('Implemented AC-1');
  });
});

describe('formatLog', () => {
  it('keeps a trailing partial non-JSON line', () => {
    expect(formatLog('hello\nworl')).toBe('hello\nworl');
  });

  it('hides a trailing partial JSON line until complete', () => {
    expect(formatLog('hello\n{"type":"assis')).toBe('hello');
  });
});
