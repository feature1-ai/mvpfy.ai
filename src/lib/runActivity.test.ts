import { describe, expect, it } from 'vitest';
import { latestActivity } from './runActivity';

/** One line of the agent's stream-json, as the CLI writes it. */
const assistant = (content: unknown) => JSON.stringify({ type: 'assistant', message: { content } });
const toolUse = (name: string, input: Record<string, unknown> = {}) =>
  assistant([{ type: 'tool_use', name, input }]);

describe('latestActivity', () => {
  it('names the file being read, not the path to it', () => {
    expect(latestActivity(toolUse('Read', { file_path: '/Users/pm/app/package.json' }))).toBe(
      'Reading package.json'
    );
  });

  it('takes the newest step, not the first', () => {
    const log = [
      toolUse('Read', { file_path: 'a.json' }),
      toolUse('Write', { file_path: '/x/docker-compose.mvpfy.yml' }),
    ].join('\n');
    expect(latestActivity(log)).toBe('Writing docker-compose.mvpfy.yml');
  });

  it("prefers a command's own description over a generic phrase", () => {
    expect(latestActivity(toolUse('Bash', { description: 'Install dependencies' }))).toBe(
      'Install dependencies'
    );
    expect(latestActivity(toolUse('Bash', {}))).toBe('Running a command');
  });

  it('falls back to naming a tool it has no phrase for', () => {
    expect(latestActivity(toolUse('SomeNewTool'))).toBe('Using SomeNewTool');
  });

  it('uses what the agent said when it is not using a tool', () => {
    const log = assistant([
      { type: 'text', text: 'This app needs a Postgres database. I will add one.' },
    ]);
    expect(latestActivity(log)).toBe('This app needs a Postgres database.');
  });

  it('shortens a long thought rather than breaking the line', () => {
    const long = `${'x'.repeat(300)} and more`;
    const out = latestActivity(assistant([{ type: 'text', text: long }]));
    expect(out).toHaveLength(100);
    expect(out?.endsWith('…')).toBe(true);
  });

  it('says nothing once the run has produced its result', () => {
    const log = [toolUse('Read', { file_path: 'a' }), JSON.stringify({ type: 'result' })].join(
      '\n'
    );
    expect(latestActivity(log)).toBeNull();
  });

  it('ignores a half-written line rather than throwing', () => {
    const log = [toolUse('Read', { file_path: 'a.json' }), '{"type":"assist'].join('\n');
    expect(latestActivity(log)).toBe('Reading a.json');
  });

  it('has nothing to say about an empty or non-JSON log', () => {
    expect(latestActivity('')).toBeNull();
    expect(latestActivity('$ claude -p\nsome plain output')).toBeNull();
  });

  it('reads a codex item nested a level down', () => {
    const log = JSON.stringify({
      type: 'item.completed',
      item: { content: [{ type: 'tool_use', name: 'Grep', input: {} }] },
    });
    expect(latestActivity(log)).toBe('Searching the code');
  });
});
