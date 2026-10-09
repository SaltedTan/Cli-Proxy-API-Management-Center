import { clientUsageApi, isClientUsageUnsupported } from '@/services/api/clientUsage';
import type { ClientUsageSnapshot } from '@/types/clientUsage';
import type { PolledSnapshotState, PolledSnapshotStatus } from '../polledSnapshot';
import { usePolledSnapshot } from './usePolledSnapshot';

/** The report is an in-memory read; a short poll keeps last-used times current. */
export const CLIENT_USAGE_POLL_INTERVAL_MS = 30_000;

export type ClientUsageStatus = PolledSnapshotStatus;

export type ClientUsageState = PolledSnapshotState<ClientUsageSnapshot>;

const readClientUsage = () => clientUsageApi.get();

/**
 * Loads `GET /observability/usage/clients`. Older backends and CLIProxyAPI Home answer
 * 404, which is reported as `unsupported` and stops polling. `scope` identifies the
 * connection; changing it discards the previous snapshot. A failed refresh keeps the
 * last snapshot, marked stale; `refreshClientUsage` resolves whether it succeeded.
 */
export function useClientUsage(enabled: boolean, scope: string) {
  const { state, refresh } = usePolledSnapshot({
    enabled,
    scope,
    intervalMs: CLIENT_USAGE_POLL_INTERVAL_MS,
    read: readClientUsage,
    isUnsupported: isClientUsageUnsupported,
  });
  return { clientUsage: state, refreshClientUsage: refresh };
}
