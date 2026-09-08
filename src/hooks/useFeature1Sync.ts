import { useCallback, useState } from 'react';
import { MvpfyState } from '../../shared/types';
import { Feature1Feature, Feature1McpClient } from '../lib/feature1Mcp';

/**
 * The features Feature1 says are yours.
 *
 * Sync is deliberately not a pull: it is one cheap read that lists what is
 * assigned to you, so the pills appear at once. Materialising a feature's
 * PRD, stories and acceptance criteria into a board is an agent run costing
 * minutes, and that only happens for the one you actually open.
 */
export interface Feature1SyncState {
  features: Feature1Feature[];
  syncing: boolean;
  /** null until the first sync; set even when the result is empty. */
  syncedAt: Date | null;
  error: string | null;
  sync(): Promise<void>;
  clear(): void;
}

export function useFeature1Sync(state: MvpfyState): Feature1SyncState {
  const [features, setFeatures] = useState<Feature1Feature[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenant = state.tenant;

  const sync = useCallback(async () => {
    if (!tenant) {
      setError('Sign in to Feature1 first.');
      return;
    }
    setSyncing(true);
    setError(null);
    try {
      const token = await window.mvpfy.keychainGet(tenant.tokenKeychainEntry);
      if (!token) throw new Error('Your Feature1 sign-in has expired — sign in again.');
      const client = new Feature1McpClient(tenant.slug, token);
      setFeatures(await client.listAssignedFeatures());
      setSyncedAt(new Date());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The server answers 401 when the token is not tied to a person, which
      // is the one failure a user can act on.
      setError(
        /401|unauthor|identity/i.test(message)
          ? 'Feature1 could not tell who you are — sign in again.'
          : message
      );
    } finally {
      setSyncing(false);
    }
  }, [tenant]);

  const clear = useCallback(() => {
    setFeatures([]);
    setSyncedAt(null);
    setError(null);
  }, []);

  return { features, syncing, syncedAt, error, sync, clear };
}
