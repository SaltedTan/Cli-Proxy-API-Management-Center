import { routingApi } from '@/services/api/routing';
import type { RoutingObservability } from '@/types/routing';
import type { PolledSnapshotState, PolledSnapshotStatus } from '../polledSnapshot';
import { usePolledSnapshot } from './usePolledSnapshot';

/** The snapshot is an in-memory read, so a short poll keeps the decision list current. */
export const ROUTING_POLL_INTERVAL_MS = 30_000;

export type RoutingObservabilityStatus = PolledSnapshotStatus;

export type RoutingObservabilityState = PolledSnapshotState<RoutingObservability>;

const isNotFound = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  'status' in error &&
  (error as { status?: unknown }).status === 404;

const readRouting = () => routingApi.getObservability();

/**
 * Loads `GET /observability/routing`. Older backends answer 404, which is reported
 * as `unsupported` so the UI can fall back to config and credential state only.
 * `scope` identifies the connection; changing it discards the previous snapshot. A
 * failed refresh keeps the last snapshot, marked stale; `refreshRouting` resolves
 * whether it succeeded.
 */
export function useRoutingObservability(enabled: boolean, scope: string) {
  const { state, refresh } = usePolledSnapshot({
    enabled,
    scope,
    intervalMs: ROUTING_POLL_INTERVAL_MS,
    read: readRouting,
    isUnsupported: isNotFound,
  });
  return { routing: state, refreshRouting: refresh };
}
