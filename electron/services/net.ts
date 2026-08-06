import * as net from 'node:net';
import { McpFetchRequest, McpFetchResponse } from '../../shared/types';

/** Network helpers: free-port discovery, local HTTP probing, MCP proxy. */

/** Find a free localhost port, starting at `start` and walking upward. */
export function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > 65000) {
        reject(new Error('No free port found'));
        return;
      }
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    tryPort(Math.max(1024, start));
  });
}

/** Check whether a local URL answers HTTP at all (any status counts as up). */
export async function probeUrl(url: string): Promise<{ reachable: boolean; status: number }> {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
    ) {
      return { reachable: false, status: 0 };
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return { reachable: true, status: res.status };
  } catch {
    return { reachable: false, status: 0 };
  }
}

/** Feature1 MCP fetch proxy (runs in main to avoid renderer CORS limits). */
export async function mcpFetch(req: McpFetchRequest): Promise<McpFetchResponse> {
  try {
    const url = new URL(req.url);
    if (url.protocol !== 'https:') {
      return { ok: false, status: 0, body: '', error: 'Only https URLs are allowed' };
    }
    const res = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers,
      body: req.body,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
