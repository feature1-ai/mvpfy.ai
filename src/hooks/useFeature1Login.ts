import { useCallback, useState } from 'react';
import { MvpfyState } from '../../shared/types';
import { Feature1McpClient, mcpHost, tenantSlugFrom, tokenKeychainEntry } from '../lib/feature1Mcp';
import { UpdateState } from './useProjectController';

/**
 * Signing in to Feature1: address → browser login → token in the keychain.
 *
 * A hook rather than code inside Settings, because signing in belongs
 * wherever the user first wants something from Feature1 — being sent to
 * Settings to find a form is the reason people never connect it at all.
 */
export interface Feature1LoginState {
  address: string;
  setAddress(value: string): void;
  /** 'waiting' spans the browser round trip, which the user completes by hand. */
  status: 'idle' | 'waiting' | 'error';
  error: string | null;
  connected: boolean;
  host: string | null;
  connect(): Promise<boolean>;
  disconnect(): void;
}

export function useFeature1Login(state: MvpfyState, updateState: UpdateState): Feature1LoginState {
  const [address, setAddress] = useState(state.tenant?.slug ?? '');
  const [status, setStatus] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    // People know the address in their browser, not their "slug".
    const slug = tenantSlugFrom(address);
    if (!slug) {
      setStatus('error');
      setError(
        `"${address.trim()}" doesn't look like a Feature1 workspace. Paste its address, e.g. acme.feature1.ai`
      );
      return false;
    }
    setStatus('waiting');
    setError(null);
    try {
      const client = new Feature1McpClient(slug, null);
      const { loginUrl, loginId } = await client.browserLogin();
      await window.mvpfy.openExternal(loginUrl);
      const token = await client.pollLoginStatus(loginId);
      const entry = tokenKeychainEntry(slug);
      await window.mvpfy.keychainSet(entry, token);
      updateState((prev) => ({
        ...prev,
        tenant: { slug, host: mcpHost(slug), tokenKeychainEntry: entry },
      }));
      setStatus('idle');
      return true;
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [address, updateState]);

  const disconnect = useCallback(() => {
    updateState((prev) => ({ ...prev, tenant: null }));
    setStatus('idle');
    setError(null);
  }, [updateState]);

  return {
    address,
    setAddress,
    status,
    error,
    connected: state.tenant !== null,
    host: state.tenant?.host ?? null,
    connect,
    disconnect,
  };
}
