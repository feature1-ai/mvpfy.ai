import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_STATE } from '../shared/types';
import { useFeature1Login } from '../src/hooks/useFeature1Login';
import { useFeature1Sync } from '../src/hooks/useFeature1Sync';
import Feature1LoginPrompt from '../src/views/Feature1LoginPrompt';
import '../src/index.css';

// Browser-only regression harness. All credentials and responses are synthetic.
const keys = new Map([['satorixr-entry', 'satorixr-token']]);
const controls = {
  delay: false,
  deny: false,
  release: null as null | (() => void),
  calls: [] as string[],
};
Object.assign(window, {
  controls,
  mvpfy: {
    keychainGet: async (key: string) => keys.get(key),
    keychainSet: async (key: string, value: string) => {
      keys.set(key, value);
    },
    openExternal: async () => {},
    mcpFetch: async (req: { url: string; headers?: Record<string, string>; body?: string }) => {
      controls.calls.push(req.url);
      const token = req.headers?.Authorization;
      const slug = token === 'Bearer watiq-token' ? 'watiq' : 'satorixr';
      const response = (data: unknown) => ({ ok: true, status: 200, body: JSON.stringify(data) });
      if (req.url.endsWith('/auth/me'))
        return controls.deny
          ? { ok: false, status: 401, body: '{}' }
          : response({ tenant: { id: slug, slug }, user: { id: `${slug}-user` } });
      if (JSON.parse(req.body || '{}').params?.name === 'browser_login')
        return response({ result: { loginUrl: 'https://watiq-mcp.feature1.ai/login' } });
      if (controls.delay) {
        controls.delay = false;
        await new Promise<void>((resolve) => {
          controls.release = resolve;
        });
      }
      return response({
        result: {
          structuredContent: {
            features: [{ id: slug, code: `${slug}-F-1`, title: `${slug} feature` }],
          },
        },
      });
    },
  },
});
function Harness() {
  const [state, setState] = useState(DEFAULT_STATE);
  const login = useFeature1Login(state, setState);
  const sync = useFeature1Sync(state, setState);
  return (
    <main className="mx-auto max-w-xl p-6">
      <Feature1LoginPrompt login={login} />
      <p data-testid="tenant">{state.tenant?.slug || 'disconnected'}</p>
      <button onClick={() => void sync.sync()}>Sync features</button>
      <button onClick={login.disconnect}>Disconnect</button>
      <button
        onClick={() =>
          setState((s) => ({
            ...s,
            tenant: {
              slug: 'satorixr',
              host: 'satorixr-mcp.feature1.ai',
              tokenKeychainEntry: 'satorixr-entry',
            },
          }))
        }
      >
        Switch workspace
      </button>
      <p data-testid="sync-state">{sync.syncing ? 'loading' : 'idle'}</p>
      <p data-testid="error">{sync.error}</p>
      <ul>
        {sync.features.map((f) => (
          <li key={f.id}>{f.title}</li>
        ))}
      </ul>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
