import { describe, expect, it } from 'vitest';
import { parseDemoCredentials } from './credentials';

describe('parseDemoCredentials', () => {
  it('parses a demo_login mapping', () => {
    const yml = [
      'app:',
      '  name: Test',
      'demo_login:',
      '  url: http://localhost:4101',
      '  email: demo@example.com',
      '  password: DemoPass123!',
    ].join('\n');
    const creds = parseDemoCredentials(yml);
    expect(creds).toHaveLength(1);
    expect(creds[0].label).toBe('App login');
    expect(creds[0].fields).toContainEqual({ key: 'email', value: 'demo@example.com' });
  });

  it('parses a demo_credentials list', () => {
    const yml = [
      'demo_credentials:',
      '  - label: Admin',
      '    username: admin',
      '    password: admin',
    ].join('\n');
    const creds = parseDemoCredentials(yml);
    expect(creds).toHaveLength(1);
    expect(creds[0].label).toBe('Admin');
  });

  it('returns empty for missing content or invalid yaml', () => {
    expect(parseDemoCredentials(null)).toEqual([]);
    expect(parseDemoCredentials('][ not yaml')).toEqual([]);
    expect(parseDemoCredentials('app:\n  name: x')).toEqual([]);
  });
});
