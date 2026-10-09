import { useCallback, useEffect, useRef } from 'react';
import { apiClient } from '@/services/api/client';
import { useAuthStore } from '@/stores';
import type { PluginPollScope } from './pluginPolling';

/**
 * Returns a factory for the scope of a new plugin operation. Its signal aborts when the page
 * unmounts or the management connection changes, which also stops any status polling.
 */
export function usePluginPollScope(): () => PluginPollScope {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => controller.abort();
  }, [apiBase, managementKey, connectionStatus]);

  return useCallback(
    () => ({
      signal: controllerRef.current?.signal,
      connectionRevision: apiClient.getConnectionRevision(),
    }),
    []
  );
}
