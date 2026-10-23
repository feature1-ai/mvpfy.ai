import { describe, expect, it } from 'vitest';
import {
  envNeedsAttention,
  envStatusFor,
  envStatusHint,
  envStatusLabel,
  parseEnv,
  updateEnv,
} from './envFile';

const sample = [
  '# Database',
  'DATABASE_URL=postgres://localhost/dev',
  '',
  'export SMTP_PORT=1025',
  'QUOTED="hello world"',
  'EMPTY=',
].join('\n');

describe('parseEnv', () => {
  it('parses keys, values, export prefix, and quotes', () => {
    expect(parseEnv(sample)).toEqual([
      { key: 'DATABASE_URL', value: 'postgres://localhost/dev' },
      { key: 'SMTP_PORT', value: '1025' },
      { key: 'QUOTED', value: 'hello world' },
      { key: 'EMPTY', value: '' },
    ]);
  });

  it('skips comments and blanks', () => {
    expect(parseEnv('# just a comment\n\n')).toEqual([]);
  });
});

describe('updateEnv', () => {
  it('updates values in place, preserving comments and order', () => {
    const next = updateEnv(sample, [
      { key: 'DATABASE_URL', value: 'postgres://db:5432/app' },
      { key: 'SMTP_PORT', value: '1025' },
      { key: 'QUOTED', value: 'hello world' },
      { key: 'EMPTY', value: '' },
    ]);
    expect(next).toContain('# Database');
    expect(next).toContain('DATABASE_URL=postgres://db:5432/app');
    expect(next.indexOf('# Database')).toBeLessThan(next.indexOf('DATABASE_URL'));
  });

  it('appends new keys at the end', () => {
    const next = updateEnv(sample, [{ key: 'STRIPE_API_KEY', value: 'sk_test_123' }]);
    expect(next.trimEnd().endsWith('STRIPE_API_KEY=sk_test_123')).toBe(true);
    expect(next).toContain('DATABASE_URL=postgres://localhost/dev');
  });

  it('quotes values containing spaces', () => {
    const next = updateEnv('', [{ key: 'GREETING', value: 'hello there' }]);
    expect(next).toContain('GREETING="hello there"');
  });
});

describe('has the running app actually picked this up', () => {
  it('says nothing when there is nothing to ask', () => {
    // Not running, or docker would not answer. Reporting "not in the
    // running app" here would send somebody hunting a bug that is not there.
    expect(envStatusFor('API_URL', 'x', null)).toBe('unknown');
    expect(envStatusLabel('unknown')).toBe('');
  });

  it('knows the container has exactly this value', () => {
    expect(
      envStatusFor('API_URL', 'http://localhost:4001', { API_URL: 'http://localhost:4001' })
    ).toBe('live');
  });

  it('knows the container is still running with the old value', () => {
    // The case the editor could never show: saved, and the app has not been
    // recreated since, so it is reading something else.
    const status = envStatusFor('API_URL', 'http://localhost:4002', {
      API_URL: 'http://localhost:4001',
    });
    expect(status).toBe('stale');
    expect(envStatusHint(status)).toMatch(/Restart it to apply/);
  });

  it('knows the container does not have the variable at all', () => {
    expect(envStatusFor('API_URL', 'x', { OTHER: 'y' })).toBe('absent');
  });

  it('does not call an absent variable a mistake', () => {
    // A front end that inlines its API address at build time genuinely has
    // no such variable in its container and is working perfectly. The hint
    // names both causes rather than picking the alarming one.
    const hint = envStatusHint('absent');
    expect(hint).toMatch(/when it is built/);
    expect(hint).toMatch(/not the file it reads/);
    expect(hint).not.toMatch(/error|wrong|broken/i);
  });

  it('tells an empty container apart from one it could not read', () => {
    expect(envStatusFor('API_URL', 'x', {})).toBe('absent');
    expect(envStatusFor('API_URL', 'x', null)).toBe('unknown');
  });

  it('matches an empty value, which is a value', () => {
    expect(envStatusFor('DEBUG', '', { DEBUG: '' })).toBe('live');
    expect(envStatusFor('DEBUG', '', { DEBUG: '1' })).toBe('stale');
  });

  it('draws the eye only to what is worth looking at', () => {
    expect(envNeedsAttention(['live', 'live'])).toBe(false);
    expect(envNeedsAttention(['live', 'unknown'])).toBe(false);
    expect(envNeedsAttention(['live', 'stale'])).toBe(true);
    expect(envNeedsAttention(['absent'])).toBe(true);
  });
});
