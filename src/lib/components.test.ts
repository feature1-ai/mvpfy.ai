import { describe, expect, it } from 'vitest';
import {
  addComponent,
  componentLine,
  isClient,
  needsAnswer,
  parseComponents,
  runsLocally,
  safeEnvPath,
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

describe('a phone or desktop app is a client, not a service', () => {
  it('never runs in the environment mvpfy builds', () => {
    // No container is an installed app on somebody's phone. Saying "runs here"
    // beside a web app put a green dot next to something unopenable.
    const list = parseComponents(
      file([
        { id: 'web', name: 'Website', kind: 'web', state: 'found' },
        { id: 'android', name: 'Android app', kind: 'mobile', state: 'found' },
        { id: 'desktop', name: 'Desktop app', kind: 'desktop', state: 'found' },
      ])
    );
    expect(list.map(runsLocally)).toEqual([true, false, false]);
    expect(isClient('mobile')).toBe(true);
    expect(isClient('desktop')).toBe(true);
    expect(isClient('web')).toBe(false);
  });

  it('tells the builder the address to point it at, which is the useful half', () => {
    const [client] = parseComponents(file([{ name: 'Android app', kind: 'mobile' }]));
    expect(componentLine(client, 'http://localhost:4102')).toBe(
      'you run this one — point it at http://localhost:4102'
    );
  });

  it('still says plainly when one was left out', () => {
    const [client] = parseComponents(
      file([{ name: 'Android app', kind: 'mobile', state: 'missing', decision: 'skip' }])
    );
    expect(componentLine(client, 'http://localhost:4102')).toBe('left out');
  });

  it('says what a service is doing, unchanged', () => {
    const [api] = parseComponents(
      file([{ name: 'API', kind: 'api', state: 'found', decision: 'remote' }])
    );
    expect(componentLine(api, 'http://localhost:4102')).toBe('use the one already running');
  });
});

describe('where each part reads its own env', () => {
  it('keeps a path inside the workspace that is actually an env file', () => {
    expect(safeEnvPath('.env')).toBe(true);
    expect(safeEnvPath('web/.env')).toBe(true);
    expect(safeEnvPath('apps/admin/.env.local')).toBe(true);
    expect(safeEnvPath('web\\.env')).toBe(true);
  });

  it('refuses a path that climbs out, or is not env at all', () => {
    // Read from a model-written file and then written TO: a wrong path here
    // overwrites something that is not env.
    expect(safeEnvPath('../../.env')).toBe(false);
    expect(safeEnvPath('/etc/passwd')).toBe(false);
    expect(safeEnvPath('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(false);
    expect(safeEnvPath('web/package.json')).toBe(false);
    expect(safeEnvPath('')).toBe(false);
  });

  it('carries it on the component that reads it', () => {
    const [web] = parseComponents(
      file([{ name: 'Web', kind: 'web', state: 'found', repo: 'web', envFile: 'web/.env' }])
    );
    expect(web.envFile).toBe('web/.env');
    // A path that is not safe is dropped rather than carried.
    const [bad] = parseComponents(file([{ name: 'Web', envFile: '../../../.ssh/config' }]));
    expect(bad.envFile).toBeUndefined();
  });
});
