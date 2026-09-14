import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORY_LIMIT,
  LOG_LIMIT,
  loadRunHistory,
  mergeHistory,
  parseHistory,
  saveRunHistory,
  serializeHistory,
} from './runHistory';
import type { RunState } from './useRuns';

const run = (id: string, running = false): RunState => ({
  handle: { runId: id, kind: 'raise-pr', projectId: 'project' },
  log: 'fatal: Authentication failed\n',
  running,
  exitCode: running ? null : 1,
  prUrl: null,
});
afterEach(() => vi.unstubAllGlobals());

describe('completed log history', () => {
  it('restores failed and stopped runs without requiring a current run', () => {
    const completed = [run('failed'), { ...run('stopped'), exitCode: null }];
    expect(mergeHistory(parseHistory(serializeHistory(completed)), [])).toEqual(completed);
  });
  it('does not restore unfinished runs as active work', () => {
    expect(parseHistory(serializeHistory([run('active', true)]))).toEqual([]);
    expect(parseHistory(JSON.stringify([run('active', true)]))).toEqual([]);
  });
  it('keeps full live output when a run is also in saved history', () => {
    const live = { ...run('same'), log: 'new output' };
    expect(mergeHistory([run('same')], [live])).toEqual([live]);
  });
  it('bounds saved history and retains the end of each log', () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({
      ...run(String(i)),
      log: 'x'.repeat(LOG_LIMIT) + 'last error',
    }));
    const restored = parseHistory(serializeHistory(entries));
    expect(restored).toHaveLength(HISTORY_LIMIT);
    expect(restored[0].handle.runId).toBe('5');
    expect(restored[0].log).toHaveLength(LOG_LIMIT);
    expect(restored[0].log.endsWith('last error')).toBe(true);
  });
  it('ignores corrupt storage and malformed entries', () => {
    expect(parseHistory('{oops')).toEqual([]);
    expect(parseHistory('{}')).toEqual([]);
    expect(parseHistory(JSON.stringify([null, {}, { handle: null }, run('valid')]))).toEqual([
      run('valid'),
    ]);
  });
  it('saves and reloads from device storage', () => {
    let value: string | null = null;
    vi.stubGlobal('localStorage', {
      setItem: (_key: string, data: string) => {
        value = data;
      },
      getItem: () => value,
    });
    saveRunHistory([run('saved')]);
    expect(loadRunHistory()).toEqual([run('saved')]);
  });
  it('keeps the newest run if storage cannot fit older runs', () => {
    let value: string | null = null;
    vi.stubGlobal('localStorage', {
      setItem: (_key: string, data: string) => {
        if (JSON.parse(data).length > 1) throw new Error('quota');
        value = data;
      },
      getItem: () => value,
    });
    saveRunHistory([run('older'), run('newest')]);
    expect(loadRunHistory()).toEqual([run('newest')]);
  });
});
