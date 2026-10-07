import { useCallback, useEffect, useRef, useState } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { apiClient } from '@/services/api/client';
import { clientUsageApi, isClientUsageUnsupported } from '@/services/api/clientUsage';
import type { ClientUsageSnapshot } from '@/types/clientUsage';

/** The report is an in-memory read; a short poll keeps last-used times current. */
export const CLIENT_USAGE_POLL_INTERVAL_MS = 30_000;

export type ClientUsageStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export interface ClientUsageState {
  status: ClientUsageStatus;
  data: ClientUsageSnapshot | null;
}

const IDLE_STATE: ClientUsageState = { status: 'idle', data: null };

/**
 * Loads `GET /observability/usage/clients`. Older backends and CLIProxyAPI Home answer
 * 404, which is reported as `unsupported` and stops polling. `scope` identifies the
 * connection; changing it discards the previous snapshot.
 */
export function useClientUsage(enabled: boolean, scope: string) {
  const [state, setState] = useState<ClientUsageState>(IDLE_STATE);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++requestIdRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestIdRef.current && revision === apiClient.getConnectionRevision();

    setState((previous) => (previous.data ? previous : { status: 'loading', data: null }));
    try {
      const data = await clientUsageApi.get();
      if (isCurrent()) setState({ status: 'ready', data });
    } catch (error) {
      if (!isCurrent()) return;
      if (isClientUsageUnsupported(error)) {
        setState({ status: 'unsupported', data: null });
        return;
      }
      // Keep the last good snapshot visible; a transient failure should not blank the panel.
      setState((previous) => ({ status: previous.data ? 'ready' : 'error', data: previous.data }));
    }
  }, [enabled]);

  useEffect(() => {
    requestIdRef.current += 1;
    setState(IDLE_STATE);
    if (enabled) void load();
  }, [enabled, scope, load]);

  useInterval(
    () => {
      void load();
    },
    enabled && state.status !== 'unsupported' ? CLIENT_USAGE_POLL_INTERVAL_MS : null
  );

  return { clientUsage: state, refreshClientUsage: load };
}
