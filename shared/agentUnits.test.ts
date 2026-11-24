import { describe, expect, it } from 'vitest';
import { parseUnitProgress, repairPromptFor, serializeUnitProgress } from './agentUnits';
import { manifestPorts } from './manifest';

describe('the record of finished steps', () => {
  it('round-trips', () => {
    const progress = { version: 1 as const, done: ['stack', 'manifest'] };
    expect(parseUnitProgress(serializeUnitProgress(progress))).toEqual(progress);
  });

  it('is nothing finished when it is missing, empty, mangled or from another version', () => {
    for (const content of [null, undefined, '', '{not json', '[]', '{"version":2,"done":["a"]}']) {
      expect(parseUnitProgress(content)).toEqual({ version: 1, done: [] });
    }
  });

  it('keeps the conversation the steps share, and which agent opened it', () => {
    const progress = {
      version: 1 as const,
      done: ['containers'],
      conversation: { agent: 'codex' as const, id: 'thr_9' },
    };
    expect(parseUnitProgress(serializeUnitProgress(progress))).toEqual(progress);
  });

  it('drops a conversation it cannot make sense of', () => {
    for (const conversation of [{ agent: 'gemini', id: 'x' }, { agent: 'claude' }, 'abc', null]) {
      const parsed = parseUnitProgress(JSON.stringify({ version: 1, done: [], conversation }));
      expect(parsed.conversation).toBeUndefined();
    }
  });

  it('drops anything in the list that is not a step id', () => {
    expect(parseUnitProgress('{"version":1,"done":["stack",7,null]}').done).toEqual(['stack']);
  });
});

describe('repairPromptFor', () => {
  it('puts what went wrong in front of the whole original brief', () => {
    const prompt = repairPromptFor('ORIGINAL', {
      failure: 'mvpfy.yml is missing',
      attempt: 2,
      of: 3,
    });
    expect(prompt).toContain('attempt 2 of 3');
    expect(prompt.indexOf('mvpfy.yml is missing')).toBeLessThan(prompt.indexOf('ORIGINAL'));
    expect(prompt.endsWith('ORIGINAL')).toBe(true);
    expect(prompt).toContain('do not make the check pass by removing what it is checking');
  });
});

describe('manifestPorts', () => {
  it('reads the port from both places it is written', () => {
    expect(manifestPorts('host_port: "3001"\nurl: http://localhost:3002/app\n')).toEqual({
      hostPort: 3001,
      urlPort: 3002,
    });
  });

  it('is null where the file does not say', () => {
    expect(manifestPorts('name: shop\n')).toEqual({ hostPort: null, urlPort: null });
    expect(manifestPorts(null)).toEqual({ hostPort: null, urlPort: null });
  });
});
