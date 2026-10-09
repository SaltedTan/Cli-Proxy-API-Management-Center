/**
 * A dashboard snapshot that is loaded, polled and refreshed on demand.
 *
 * A failed refresh keeps the last good snapshot on screen, since a transient failure
 * should not blank a panel, but marks it `stale` with the time it was loaded, so an
 * outage cannot pass for live data. React-free so the transitions are testable; the
 * store contract (`subscribe` / `getSnapshot`) is what `useSyncExternalStore` wants.
 */

import type { NotificationType } from '@/types';

export type PolledSnapshotStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export interface PolledSnapshotState<T> {
  status: PolledSnapshotStatus;
  /** The last snapshot loaded; kept when a later refresh fails. */
  data: T | null;
  /** When `data` was loaded. */
  updatedAtMs?: number;
  /** The latest refresh failed, so `data` may be out of date. */
  stale?: boolean;
}

export const IDLE_SNAPSHOT_STATE: PolledSnapshotState<never> = { status: 'idle', data: null };
const UNSUPPORTED_STATE: PolledSnapshotState<never> = { status: 'unsupported', data: null };
const LOADING_STATE: PolledSnapshotState<never> = { status: 'loading', data: null };
const ERROR_STATE: PolledSnapshotState<never> = { status: 'error', data: null };

export interface PolledSnapshotOptions<T> {
  read: () => Promise<T>;
  /** Errors meaning the backend does not offer the snapshot (polling then stops). */
  isUnsupported?: (error: unknown) => boolean;
  /** Changes with the connection; a read started on another connection is discarded. */
  connectionRevision?: () => number;
  now?: () => number;
}

export interface PolledSnapshot<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PolledSnapshotState<T>;
  /**
   * Loads the snapshot now. Resolves false when the load failed or was discarded, so
   * callers that changed something can tell whether the view shows the change.
   */
  refresh(): Promise<boolean>;
  /** Back to idle for another connection; results of reads in flight are discarded. */
  reset(): void;
}

export function createPolledSnapshot<T>({
  read,
  isUnsupported = () => false,
  connectionRevision = () => 0,
  now = Date.now,
}: PolledSnapshotOptions<T>): PolledSnapshot<T> {
  let state: PolledSnapshotState<T> = IDLE_SNAPSHOT_STATE;
  let requestId = 0;
  const listeners = new Set<() => void>();

  const set = (next: PolledSnapshotState<T>) => {
    if (next === state) return;
    state = next;
    listeners.forEach((listener) => listener());
  };

  const refresh = async (): Promise<boolean> => {
    const id = ++requestId;
    const revision = connectionRevision();
    const isCurrent = () => id === requestId && revision === connectionRevision();

    if (!state.data) set(LOADING_STATE);
    try {
      const data = await read();
      if (!isCurrent()) return false;
      set({ status: 'ready', data, updatedAtMs: now() });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if (isUnsupported(error)) {
        // The view is accurate: there is nothing to show.
        set(UNSUPPORTED_STATE);
        return true;
      }
      if (!state.data) set(ERROR_STATE);
      else if (!state.stale) set({ ...state, status: 'ready', stale: true });
      return false;
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    refresh,
    reset() {
      requestId += 1;
      set(IDLE_SNAPSHOT_STATE);
    },
  };
}

/**
 * The notification for a change that was made when the view could not be reloaded to
 * show it; null when it was reloaded. `void` comes from callers that do not report it.
 */
export function unrefreshedChangeNotice(
  refreshed: boolean | void,
  key: string
): { key: string; type: NotificationType } | null {
  return refreshed === false ? { key, type: 'warning' } : null;
}
