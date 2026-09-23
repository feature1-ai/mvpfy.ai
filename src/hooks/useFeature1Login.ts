import { useCallback, useEffect, useRef, useState } from 'react';
import { MvpfyState } from '../../shared/types';
import { Feature1McpClient, mcpHost, tenantSlugFrom, tokenKeychainEntry } from '../lib/feature1Mcp';
import { UpdateState } from './useProjectController';

export interface Feature1LoginState {
  address: string;
  setAddress(value: string): void;
  token: string;
  setToken(value: string): void;
  status: 'idle' | 'waiting' | 'error';
  error: string | null;
  notice: string | null;
  connected: boolean;
  host: string | null;
  connect(): Promise<boolean>;
  disconnect(): void;
}

export function useFeature1Login(state: MvpfyState, updateState: UpdateState): Feature1LoginState {
  const [address, setAddressValue] = useState(state.tenant?.slug ?? '');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      ++attempt.current;
    },
    []
  );
  const setAddress = useCallback((value: string) => {
    ++attempt.current;
    setAddressValue(value);
    setToken('');
    setStatus('idle');
    setNotice(null);
  }, []);

  const connect = useCallback(async () => {
    const slug = tenantSlugFrom(address);
    if (!slug) {
      setStatus('error');
      setError('Enter your Feature1 workspace address.');
      return false;
    }
    const request = ++attempt.current;
    setStatus('waiting');
    setError(null);
    setNotice(null);
    // Disconnect first: a failed reconnect must not leave another account active.
    updateState((prev) => ({ ...prev, tenant: null }));
    try {
      if (!token.trim()) {
        const { loginUrl } = await new Feature1McpClient(slug, null).browserLogin();
        if (request !== attempt.current) return false;
        await window.mvpfy.openExternal(loginUrl);
        if (request !== attempt.current) return false;
        setNotice(
          'Finish browser sign-in, then paste your personal token below and select Verify and connect. You can also use a personal integration token from Feature1 Settings.'
        );
        setStatus('idle');
        return false;
      }
      const value = token.trim();
      const identity = await new Feature1McpClient(slug, value).verifyIdentity();
      if (request !== attempt.current) return false;
      // A new entry on reconnect keeps in-flight requests bound to the old credential.
      const entry = `${tokenKeychainEntry(slug)}-${identity.user.id}-${crypto.randomUUID()}`;
      await window.mvpfy.keychainSet(entry, value);
      if (request !== attempt.current) return false;
      updateState((prev) => ({
        ...prev,
        tenant: { slug, host: mcpHost(slug), tokenKeychainEntry: entry },
      }));
      setToken('');
      setStatus('idle');
      return true;
    } catch (err) {
      if (request === attempt.current) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
      return false;
    }
  }, [address, token, updateState]);

  const disconnect = useCallback(() => {
    ++attempt.current;
    updateState((prev) => ({ ...prev, tenant: null }));
    setToken('');
    setStatus('idle');
    setError(null);
    setNotice(null);
  }, [updateState]);

  return {
    address,
    setAddress,
    token,
    setToken,
    status,
    error,
    notice,
    connected: Boolean(state.tenant?.tokenKeychainEntry),
    host: state.tenant?.host ?? null,
    connect,
    disconnect,
  };
}
