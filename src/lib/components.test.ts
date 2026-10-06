import { describe, expect, it } from 'vitest';
import {
  needsAnswer,
  parseComponents,
  unanswered,
  withDecision,
  type ProductComponent,
} from './components';

const file = (components: unknown) => JSON.stringify({ components });

const found = (name: string, kind = 'web'): ProductComponent => ({
  id: name,
  name,
  kind: kind as ProductComponent['kind'],
  state: 'found',
  evidence: 'package.json',
});

describe('parseComponents', () => {
  it('reads the inventory the setup run wrote', () => {
    const list = parseComponents(
      file([
        { id: 'portal', name: 'Customer portal', kind: 'web', state: 'found', repo: 'web' },
        { id: 'api', name: 'Orders API', kind: 'api', state: 'found', repo: 'api' },
        {
          id: 'admin',
          name: 'Admin dashboard',
          kind: 'admin',
          state: 'missing',
          evidence: 'VITE_ADMIN_URL points at admin.example.com, no code here',
        },
      ])
    );
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ name: 'Customer portal', kind: 'web', repo: 'web' });
    expect(list[2]).toMatchObject({ state: 'missing', evidence: expect.stringContaining('VITE') });
  });

  it('costs a malformed entry that entry, not the whole list', () => {
    // Written by a model: one bad row must not take the inventory with it.
    const list = parseComponents(file([{ name: '' }, found('Web'), 'nonsense', null]));
    expect(list.map((c) => c.name)).toEqual(['Web']);
  });

  it('calls an unfamiliar kind a service, which is true of anything that runs', () => {
    expect(parseComponents(file([{ name: 'Search', kind: 'elasticsearch' }]))[0].kind).toBe(
      'service'
    );
  });

  it('treats anything but "missing" as found, so a typo cannot invent a question', () => {
    expect(parseComponents(file([{ name: 'Web', state: 'prseent' }]))[0].state).toBe('found');
  });

  it('is empty rather than throwing on anything that is not the file', () => {
    expect(parseComponents(null)).toEqual([]);
    expect(parseComponents('not json')).toEqual([]);
    expect(parseComponents('{}')).toEqual([]);
    expect(parseComponents(file('nope'))).toEqual([]);
  });
});

describe('needsAnswer', () => {
  it('does not ask about what it found', () => {
    // Setting up starts by itself. A question with an obvious answer is the
    // friction that teaches people to stop reading questions.
    expect(needsAnswer([found('Web'), found('API', 'api')])).toBe(false);
  });

  it('asks when the code refers to something that is not here', () => {
    const list = parseComponents(
      file([found('Web'), { name: 'Admin dashboard', kind: 'admin', state: 'missing' }])
    );
    expect(needsAnswer(list)).toBe(true);
    expect(unanswered(list).map((c) => c.name)).toEqual(['Admin dashboard']);
  });

  it('stops asking once it has been answered', () => {
    const list = parseComponents(
      file([{ id: 'admin', name: 'Admin dashboard', kind: 'admin', state: 'missing' }])
    );
    expect(needsAnswer(withDecision(list, 'admin', 'stand-in'))).toBe(false);
    expect(needsAnswer(withDecision(list, 'admin', 'skip'))).toBe(false);
    // An answer for something else is not an answer for this.
    expect(needsAnswer(withDecision(list, 'other', 'skip'))).toBe(true);
  });

  it('reads a decision the file already carries', () => {
    const list = parseComponents(
      file([{ name: 'Mobile app', kind: 'mobile', state: 'missing', decision: 'skip' }])
    );
    expect(list[0].decision).toBe('skip');
    expect(needsAnswer(list)).toBe(false);
  });
});
