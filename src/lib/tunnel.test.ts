import { describe, expect, it } from 'vitest';
import { parseTunnelUrl, tunnelRefused } from './tunnel';

// Verbatim from cloudflared 2026.3.0, which prints the address once, boxed,
// among fifty lines about connector ids and protocols.
const REAL_LOG = [
  '2026-09-22T08:12:49Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-09-22T08:12:54Z INF +------------------------------------------+',
  '2026-09-22T08:12:54Z INF |  Your quick Tunnel has been created! Visit it at:  |',
  '2026-09-22T08:12:54Z INF |  https://sorts-preparing-climb-gospel.trycloudflare.com  |',
  '2026-09-22T08:12:54Z INF +------------------------------------------+',
  '2026-09-22T08:12:54Z INF Settings: map[ha-connections:1 protocol:quic url:http://localhost:8731]',
].join('\n');

describe('parseTunnelUrl', () => {
  it('finds the address in what cloudflared actually prints', () => {
    expect(parseTunnelUrl(REAL_LOG)).toBe('https://sorts-preparing-climb-gospel.trycloudflare.com');
  });

  it('does not mistake the local address it was pointed at for the public one', () => {
    // The log carries http://localhost:8731 too; sharing that with somebody
    // would be a link that only works on the machine it came from.
    expect(parseTunnelUrl(REAL_LOG)).not.toContain('localhost');
  });

  it('says nothing until the address exists', () => {
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(parseTunnelUrl('')).toBeNull();
    expect(parseTunnelUrl(null)).toBeNull();
  });
});

describe('tunnelRefused', () => {
  it('spots a quick tunnel being refused, which is a link going dead', () => {
    expect(tunnelRefused('ERR failed to request quick tunnel: 429 Too Many Requests')).toBe(true);
  });

  it('leaves an ordinary line alone', () => {
    expect(tunnelRefused(REAL_LOG)).toBe(false);
  });
});
