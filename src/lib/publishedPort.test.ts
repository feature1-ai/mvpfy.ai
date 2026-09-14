import { describe, expect, it } from 'vitest';
import {
  parseEnvFile,
  parsePublishedPort,
  parsePublishedPorts,
  resolveEnvRefs,
} from './publishedPort';

const compose = (ports: string) =>
  `services:\n  app:\n    build: .\n    ports:\n      - "${ports}"\n    volumes:\n      - .:/app\n`;

describe('parsePublishedPort', () => {
  it('resolves the variable before splitting, not after', () => {
    // "${HOST_PORT:-4106}" contains a colon of its own; splitting the raw
    // string cuts it in the wrong place and yields "${HOST_PORT".
    expect(parsePublishedPort(compose('${HOST_PORT:-4106}:${PORT:-4105}'), '')).toBe(4106);
  });

  it('prefers the env file over the fallback, which is the drift that hides', () => {
    expect(parsePublishedPort(compose('${HOST_PORT:-4106}:3000'), 'HOST_PORT=4200\n')).toBe(4200);
  });

  it('falls back when the env names the variable but leaves it empty', () => {
    expect(parsePublishedPort(compose('${HOST_PORT:-4106}:3000'), 'HOST_PORT=\n')).toBe(4106);
  });

  it('reads a plain published port', () => {
    expect(parsePublishedPort(compose('4100:3000'), '')).toBe(4100);
  });

  it('takes the first published port, which is the main app by convention', () => {
    const yml = `${compose('4100:3000')}  db:\n    ports:\n      - "5432:5432"\n`;
    expect(parsePublishedPort(yml, '')).toBe(4100);
  });

  it('is null when nothing is published or there is no file', () => {
    expect(parsePublishedPort('services:\n  app:\n    build: .\n', '')).toBeNull();
    expect(parsePublishedPort(null, '')).toBeNull();
  });

  it('ignores a volume line, which looks like a ports entry', () => {
    // "- .:/app" would otherwise parse as host "." and fail quietly.
    expect(parsePublishedPort('services:\n  app:\n    volumes:\n      - .:/app\n', '')).toBeNull();
  });
});

describe('parseEnvFile', () => {
  it('reads values, quoted or not, and ignores comments', () => {
    const env = parseEnvFile('# a note\nHOST_PORT=4200\nNAME="shop"  # trailing\n\nexport X=1\n');
    expect(env).toEqual({ HOST_PORT: '4200', NAME: 'shop', X: '1' });
  });
});

describe('resolveEnvRefs', () => {
  it('leaves an unknown variable with no fallback empty rather than literal', () => {
    expect(resolveEnvRefs('${NOPE}:3000', {})).toBe(':3000');
  });
});

describe('parsePublishedPorts', () => {
  const stack = [
    'services:',
    '  db:',
    '    image: postgres:16',
    '    ports:',
    '      - "5432:5432"',
    '    volumes:',
    '      - ./data:/var/lib/postgresql/data',
    '  web:',
    '    build: .',
    '    ports:',
    '      - "${HOST_PORT:-4106}:4105"',
    '    depends_on:',
    '      - db',
  ].join('\n');

  it('reads every service that publishes, not just the first one', () => {
    // The database sorts first in most generated stacks, so taking the first
    // number in the file compared the app port against postgres and warned
    // about a drift that was never there — every time, for ever.
    expect(parsePublishedPorts(stack, null)).toEqual([5432, 4106]);
  });

  it('ignores list items that are not ports', () => {
    // volumes: and depends_on: are lists too; only ports: entries count.
    expect(parsePublishedPorts(stack, null)).not.toContain(0);
    expect(parsePublishedPorts('services:\n  a:\n    depends_on:\n      - 8080\n', null)).toEqual(
      []
    );
  });

  it('takes the env file over the fallback, as compose does', () => {
    expect(parsePublishedPorts(stack, 'HOST_PORT=9200')).toEqual([5432, 9200]);
  });

  it('skips a bare container port, which publishes nothing fixed', () => {
    expect(parsePublishedPorts('services:\n  a:\n    ports:\n      - "8080"\n', null)).toEqual([]);
  });

  it('reads the host port out of an address-qualified entry', () => {
    expect(
      parsePublishedPorts('services:\n  a:\n    ports:\n      - "127.0.0.1:8080:80"\n', null)
    ).toEqual([8080]);
  });
});
