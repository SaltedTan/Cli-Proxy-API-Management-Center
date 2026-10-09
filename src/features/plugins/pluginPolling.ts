import { pluginsApi, pluginStoreApi } from '@/services/api';
import { apiClient } from '@/services/api/client';
import type {
  PluginListEntry,
  PluginListResponse,
  PluginStoreEntry,
  PluginStoreResponse,
} from '@/types';

const PLUGIN_STATE_TIMEOUT_MS = 15_000;
const PLUGIN_STATE_INTERVAL_MS = 500;

/** The page and connection a plugin operation belongs to. */
export interface PluginPollScope {
  /** Aborted when the page unmounts or the connection changes. */
  signal?: AbortSignal;
  /** Connection revision captured before the operation's first request. */
  connectionRevision: number;
}

export interface PluginPollOptions extends Partial<PluginPollScope> {
  timeoutMs?: number;
  intervalMs?: number;
}

const cancelled = () => new DOMException('Plugin status polling was cancelled.', 'AbortError');

/** Throws an AbortError once the operation's connection was replaced or logged out. */
export function assertPluginConnection({ connectionRevision }: PluginPollScope): void {
  if (connectionRevision !== apiClient.getConnectionRevision()) throw cancelled();
}

const assertPollActive = (scope: PluginPollScope) => {
  if (scope.signal?.aborted) throw cancelled();
  assertPluginConnection(scope);
};

/** Outcomes of a cancelled operation or an old connection must not reach the current session. */
export const isStalePluginOperation = (error: unknown, scope: PluginPollScope): boolean =>
  (error instanceof DOMException && error.name === 'AbortError') ||
  scope.connectionRevision !== apiClient.getConnectionRevision();

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(cancelled());
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface PluginStateWaitResult {
  response: PluginListResponse;
  plugin: PluginListEntry | null;
  timedOut: boolean;
}

export interface PluginStoreStateWaitResult {
  response: PluginStoreResponse;
  plugin: PluginStoreEntry | null;
  timedOut: boolean;
}

async function pollPluginState<R extends { plugins: P[] }, P>(
  read: () => Promise<R>,
  find: (plugins: P[]) => P | null,
  predicate: (plugin: P, response: R) => boolean,
  {
    signal,
    connectionRevision = apiClient.getConnectionRevision(),
    timeoutMs = PLUGIN_STATE_TIMEOUT_MS,
    intervalMs = PLUGIN_STATE_INTERVAL_MS,
  }: PluginPollOptions
): Promise<{ response: R; plugin: P | null; timedOut: boolean }> {
  const scope = { signal, connectionRevision };
  const readCurrent = async () => {
    assertPollActive(scope);
    const response = await read();
    // Another server's plugin list must not complete this server's operation.
    assertPollActive(scope);
    return response;
  };

  const deadline = Date.now() + timeoutMs;
  let latest = await readCurrent();

  for (;;) {
    const plugin = find(latest.plugins);
    if (plugin && predicate(plugin, latest)) {
      return { response: latest, plugin, timedOut: false };
    }
    if (Date.now() >= deadline) {
      return { response: latest, plugin, timedOut: true };
    }
    await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    latest = await readCurrent();
  }
}

export function waitForPluginState(
  id: string,
  predicate: (plugin: PluginListEntry, response: PluginListResponse) => boolean,
  options: PluginPollOptions = {}
): Promise<PluginStateWaitResult> {
  return pollPluginState(
    () => pluginsApi.list(),
    (plugins) => plugins.find((item) => item.id === id) ?? null,
    predicate,
    options
  );
}

export function waitForPluginStoreState(
  id: string,
  sourceId: string,
  predicate: (plugin: PluginStoreEntry, response: PluginStoreResponse) => boolean,
  options: PluginPollOptions = {}
): Promise<PluginStoreStateWaitResult> {
  return pollPluginState(
    () => pluginStoreApi.list(),
    (plugins) =>
      plugins.find((item) => item.id === id && (!sourceId || item.sourceId === sourceId)) ?? null,
    predicate,
    options
  );
}
