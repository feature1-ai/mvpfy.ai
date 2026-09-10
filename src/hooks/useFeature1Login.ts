import { useCallback, useState } from 'react';
import { MvpfyState } from '../../shared/types';
import {
  Feature1McpClient,
  mcpHost,
  signInWithPassword,
  tenantSlugFrom,
  tokenKeychainEntry,
} from '../lib/feature1Mcp';
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
  /**
   * True once the browser sign-in has proved this workspace cannot hand a
   * token back, so the email and password route is the one left.
   */
  needsPassword: boolean;
  signIn(email: string, password: string): Promise<boolean>;
  disconnect(): void;
}

export function useFeature1Login(state: MvpfyState, updateState: UpdateState): Feature1LoginState {
  const [address, setAddress] = useState(state.tenant?.slug ?? '');
  const [status, setStatus] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);

  /** Keep the token where only the OS can read it, and record the workspace. */
  const keep = useCallback(
    async (slug: string, token: string) => {
      const entry = tokenKeychainEntry(slug);
      await window.mvpfy.keychainSet(entry, token);
      updateState((prev) => ({
        ...prev,
        tenant: { slug, host: mcpHost(slug), tokenKeychainEntry: entry },
      }));
      setStatus('idle');
      setError(null);
      setNeedsPassword(false);
    },
    [updateState]
  );

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
      await keep(slug, token);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setError(message);
      // The workspace completed a sign-in but kept the token. Offer the route
      // that does return one rather than leaving a dead end.
      if (/without handing back a token/.test(message)) setNeedsPassword(true);
      return false;
    }
  }, [address, keep]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const slug = tenantSlugFrom(address);
      if (!slug) {
        setStatus('error');
        setError('Paste your Feature1 address first, e.g. acme.feature1.ai');
        return false;
      }
      setStatus('waiting');
      setError(null);
      try {
        await keep(slug, await signInWithPassword(slug, email, password));
        return true;
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [address, keep]
  );

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
    needsPassword,
    signIn,
    disconnect,
  };
}
