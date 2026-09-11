import { describe, expect, it } from 'vitest';
import { parseEnvFile, parsePublishedPort, resolveEnvRefs } from './publishedPort';

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
