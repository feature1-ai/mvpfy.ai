import { describe, expect, it } from 'vitest';
import { parseEnv, updateEnv } from './envFile';

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
