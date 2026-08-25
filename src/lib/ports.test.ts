import { describe, expect, it } from 'vitest';
import { parseAppPort, parsePorts } from './ports';

const agentYml = `
project: boardkit-by-f1
app:
  kind: web + api
  host_port: 4106
  container_port: 4105
  url: http://localhost:4106
auth: none
`;

describe('parseAppPort', () => {
  it('prefers host_port over everything else', () => {
    expect(parseAppPort(agentYml)).toBe(4106);
  });

  it('falls back to the url port when host_port is absent', () => {
    expect(parseAppPort('app:\n  url: "http://localhost:5000"\n')).toBe(5000);
    expect(parseAppPort('url: http://127.0.0.1:5001/login\n')).toBe(5001);
  });

  it('falls back to the first services entry host port', () => {
    const yml = 'services:\n  - name: web\n    ports:\n      - "4200:3000"\n';
    expect(parsePorts(yml)[0]?.port).toBe(4200);
    expect(parseAppPort(yml)).toBe(4200);
  });

  it('returns null when nothing usable exists', () => {
    expect(parseAppPort(null)).toBeNull();
    expect(parseAppPort('')).toBeNull();
    expect(parseAppPort('notes: no ports here\n')).toBeNull();
    expect(parseAppPort('url: https://example.com/app\n')).toBeNull();
  });
});
