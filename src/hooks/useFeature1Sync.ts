import { useCallback, useEffect, useRef, useState } from 'react';
import { UpdateState } from './useProjectController';
import { MvpfyState } from '../../shared/types';
import { Feature1Feature, Feature1McpClient, Feature1McpAuthError } from '../lib/feature1Mcp';

export interface Feature1SyncState {
  features: Feature1Feature[];
  syncing: boolean;
  syncedAt: Date | null;
  error: string | null;
  sync(): Promise<void>;
  clear(): void;
}

export function useFeature1Sync(state: MvpfyState, updateState: UpdateState): Feature1SyncState {
  const tenant = state.tenant;
  const identity = tenant ? `${tenant.slug}:${tenant.tokenKeychainEntry}` : '';
  const epoch = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    identity: string;
    features: Feature1Feature[];
    at: Date;
  } | null>(null);
  // Stamped with the workspace it belongs to, like the snapshot already was.
  // Deriving from that stamp is what lets a change of workspace show nothing
  // without an effect that clears state — clearing in an effect renders the
  // previous workspace's state once before removing it.
  const [status, setStatus] = useState<{
    identity: string;
    syncing: boolean;
    error: string | null;
  }>({ identity: '', syncing: false, error: null });
  // Retires every request in flight when the workspace changes, so an answer
  // for the previous one cannot land in the new one. Only the ref moves here,
  // which is what an effect is for.
  useEffect(() => {
    ++epoch.current;
    return () => {
      ++epoch.current;
    };
  }, [identity]);
  const clear = useCallback(() => {
    ++epoch.current;
    setSnapshot(null);
    setStatus({ identity: '', syncing: false, error: null });
  }, []);
  const sync = useCallback(async () => {
    const request = ++epoch.current;
    setSnapshot(null);
    setStatus({ identity, syncing: true, error: null });
    // The epoch alone settles it: changing workspace retires every request
    // through the effect above, so a stale answer can never be current.
    const current = () => request === epoch.current;
    try {
      if (!tenant?.tokenKeychainEntry)
        throw new Feature1McpAuthError('Reconnect Feature1 with your own token.');
      const token = await window.mvpfy.keychainGet(tenant.tokenKeychainEntry);
      if (!current()) return;
      if (!token) throw new Feature1McpAuthError('Your Feature1 sign-in has expired — reconnect.');
      const features = await new Feature1McpClient(tenant.slug, token).listAssignedFeatures();
      if (current()) setSnapshot({ identity, features, at: new Date() });
    } catch (err) {
      if (current()) {
        setSnapshot(null);
        setStatus({
          identity,
          syncing: false,
          error: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof Feature1McpAuthError)
          updateState((prev) =>
            prev.tenant?.tokenKeychainEntry === tenant?.tokenKeychainEntry
              ? { ...prev, tenant: null }
              : prev
          );
      }
    } finally {
      if (current()) setStatus((prev) => ({ ...prev, identity, syncing: false }));
    }
  }, [tenant, identity, updateState]);
  const visible = snapshot?.identity === identity ? snapshot : null;
  const live = status.identity === identity ? status : null;
  return {
    features: visible?.features ?? [],
    syncedAt: visible?.at ?? null,
    syncing: live?.syncing ?? false,
    error: live?.error ?? null,
    sync,
    clear,
  };
}
