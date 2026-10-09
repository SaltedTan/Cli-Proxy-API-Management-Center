import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { apiClient } from '@/services/api/client';
import { createPolledSnapshot, type PolledSnapshotState } from '../polledSnapshot';

export interface PolledSnapshotHookOptions<T> {
  enabled: boolean;
  /** Identifies the connection; changing it discards the previous snapshot. */
  scope: string;
  intervalMs: number;
  /** Read once, on mount: pass a stable function. */
  read: () => Promise<T>;
  /** Read once, on mount: pass a stable function. */
  isUnsupported?: (error: unknown) => boolean;
}

/**
 * Loads a snapshot while `enabled` and polls it every `intervalMs` until the backend
 * reports it unsupported. `refresh` resolves whether the load succeeded.
 */
export function usePolledSnapshot<T>({
  enabled,
  scope,
  intervalMs,
  read,
  isUnsupported,
}: PolledSnapshotHookOptions<T>): {
  state: PolledSnapshotState<T>;
  refresh: () => Promise<boolean>;
} {
  const [resource] = useState(() =>
    createPolledSnapshot({
      read,
      isUnsupported,
      connectionRevision: () => apiClient.getConnectionRevision(),
    })
  );
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  );

  useEffect(() => {
    resource.reset();
    if (enabled) void resource.refresh();
    return () => resource.reset();
  }, [resource, enabled, scope]);

  const refresh = useCallback(
    () => (enabled ? resource.refresh() : Promise.resolve(false)),
    [resource, enabled]
  );

  useInterval(
    () => {
      void refresh();
    },
    enabled && state.status !== 'unsupported' ? intervalMs : null
  );

  return { state, refresh };
}
