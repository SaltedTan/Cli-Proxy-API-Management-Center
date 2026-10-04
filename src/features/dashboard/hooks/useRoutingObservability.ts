import { useCallback, useEffect, useRef, useState } from 'react';
import { useInterval } from '@/hooks/useInterval';
import { apiClient } from '@/services/api/client';
import { routingApi } from '@/services/api/routing';
import type { RoutingObservability } from '@/types/routing';

/** The snapshot is an in-memory read, so a short poll keeps the decision list current. */
export const ROUTING_POLL_INTERVAL_MS = 30_000;

export type RoutingObservabilityStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export interface RoutingObservabilityState {
  status: RoutingObservabilityStatus;
  data: RoutingObservability | null;
}

const IDLE_STATE: RoutingObservabilityState = { status: 'idle', data: null };

const isNotFound = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  'status' in error &&
  (error as { status?: unknown }).status === 404;

/**
 * Loads `GET /observability/routing`. Older backends answer 404, which is reported
 * as `unsupported` so the UI can fall back to config and credential state only.
 * `scope` identifies the connection; changing it discards the previous snapshot.
 */
export function useRoutingObservability(enabled: boolean, scope: string) {
  const [state, setState] = useState<RoutingObservabilityState>(IDLE_STATE);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++requestIdRef.current;
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestIdRef.current && revision === apiClient.getConnectionRevision();

    setState((previous) => (previous.data ? previous : { status: 'loading', data: previous.data }));
    try {
      const data = await routingApi.getObservability();
      if (isCurrent()) setState({ status: 'ready', data });
    } catch (error) {
      if (!isCurrent()) return;
      if (isNotFound(error)) {
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
    enabled && state.status !== 'unsupported' ? ROUTING_POLL_INTERVAL_MS : null
  );

  return { routing: state, refreshRouting: load };
}
