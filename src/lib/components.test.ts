import { describe, expect, it } from 'vitest';
import {
  addComponent,
  needsAnswer,
  parseComponents,
  runsLocally,
  unanswered,
  validRemoteUrl,
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

describe('pointing a component at something already running', () => {
  it('accepts an address and keeps it with the decision', () => {
    const list = parseComponents(file([{ id: 'billing', name: 'Billing', kind: 'api' }]));
    const next = withDecision(list, 'billing', 'remote', 'https://billing.staging.acme.com');
    expect(next[0]).toMatchObject({
      decision: 'remote',
      url: 'https://billing.staging.acme.com',
    });
  });

  it('refuses anything that is not an address', () => {
    // This is written into a file an agent reads and an environment is built
    // from, so it has to be an address and nothing else.
    expect(validRemoteUrl('https://billing.acme.com')).toBe(true);
    expect(validRemoteUrl('http://localhost:8080')).toBe(true);
    expect(validRemoteUrl('billing.acme.com')).toBe(false);
    expect(validRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(validRemoteUrl('https://acme.com; rm -rf /')).toBe(false);
    expect(validRemoteUrl('https://acme.com $(whoami)')).toBe(false);
    expect(validRemoteUrl('')).toBe(false);
    expect(validRemoteUrl(null)).toBe(false);
  });

  it('drops a stale address when it goes back to running here', () => {
    const list = parseComponents(
      file([
        { id: 'billing', name: 'Billing', url: 'https://billing.acme.com', decision: 'remote' },
      ])
    );
    expect(withDecision(list, 'billing', 'skip')[0].url).toBeUndefined();
  });

  it('is available for a service that IS in the repo', () => {
    // The microservices case: eight here, three worth running on a laptop.
    const list = parseComponents(
      file([
        { id: 'web', name: 'Web', state: 'found', repo: 'web' },
        { id: 'billing', name: 'Billing', state: 'found', repo: 'billing' },
      ])
    );
    const next = withDecision(list, 'billing', 'remote', 'https://billing.staging.acme.com');
    // Still no question asked: a found component never gated setup, and
    // choosing to point it somewhere does not start one.
    expect(needsAnswer(next)).toBe(false);
    expect(runsLocally(next[0])).toBe(true);
    expect(runsLocally(next[1])).toBe(false);
  });

  it('knows what still needs a container', () => {
    const list = parseComponents(
      file([
        { id: 'a', name: 'A', state: 'found' },
        { id: 'b', name: 'B', state: 'missing', decision: 'elsewhere' },
        { id: 'c', name: 'C', state: 'missing', decision: 'stand-in' },
        { id: 'd', name: 'D', state: 'missing', decision: 'skip' },
      ])
    );
    expect(list.map(runsLocally)).toEqual([true, true, false, false]);
  });
});

describe('adding a part the code never revealed', () => {
  it('arrives as the same question, answered the same ways', () => {
    // A mobile app in its own repository leaves no trace in a backend, so
    // evidence-based reading will never find it. The PM is the only source.
    const list = addComponent(parseComponents(file([found('API', 'api')])), 'Driver app', 'mobile');
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ name: 'Driver app', kind: 'mobile', state: 'missing' });
    expect(needsAnswer(list)).toBe(true);
    expect(withDecision(list, list[1].id, 'remote', 'https://api.acme.com')[1].url).toBe(
      'https://api.acme.com'
    );
  });

  it('says where it came from, because every other entry says that too', () => {
    expect(addComponent([], 'Driver app', 'mobile')[0].evidence).toMatch(/you said/i);
  });

  it('never collides with an id already there', () => {
    const list = addComponent(addComponent([], 'Driver app', 'mobile'), 'Driver app', 'desktop');
    expect(new Set(list.map((c) => c.id)).size).toBe(2);
  });

  it('ignores an empty name rather than adding a nameless row', () => {
    expect(addComponent([], '   ', 'mobile')).toEqual([]);
  });
});
