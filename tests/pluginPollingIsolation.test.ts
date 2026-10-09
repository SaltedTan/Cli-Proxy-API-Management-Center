import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertPluginConnection,
  isStalePluginOperation,
  waitForPluginState,
  waitForPluginStoreState,
} from '@/features/plugins/pluginPolling';
import { apiClient } from '@/services/api/client';
import { pluginsApi, pluginStoreApi } from '@/services/api/plugins';
import type { PluginListResponse, PluginStoreEntry, PluginStoreResponse } from '@/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const spies: Array<{ mockRestore(): void }> = [];
const timerStarted: Array<() => void> = [];
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: (handler: () => void, ms: number) => {
        timerStarted.splice(0).forEach((notify) => notify());
        return setTimeout(handler, ms);
      },
      clearTimeout,
    },
  });
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

const storeResponse = (installed: boolean): PluginStoreResponse =>
  ({
    pluginsEnabled: true,
    plugins: [{ id: 'demo', sourceId: 'official', installed, configured: installed }],
  }) as unknown as PluginStoreResponse;

const isInstalled = (plugin: PluginStoreEntry) => plugin.installed && plugin.configured;

/** Serves queued store reads one at a time so the test controls when each completes. */
function queueStoreReads() {
  const reads: Array<ReturnType<typeof deferred<PluginStoreResponse>>> = [];
  const requested: Array<() => void> = [];
  const list = spyOn(pluginStoreApi, 'list').mockImplementation(() => {
    const read = deferred<PluginStoreResponse>();
    reads.push(read);
    requested.splice(0).forEach((notify) => notify());
    return read.promise;
  });
  spies.push(list);
  const nextRead = async () => {
    if (reads.length === 0) await new Promise<void>((resolve) => requested.push(resolve));
    return reads.shift()!;
  };
  /** Settles with the polling outcome, or with 'read again' if polling issues another read. */
  const outcome = (polling: Promise<unknown>) =>
    Promise.race([
      polling.then(
        () => 'resolved',
        (error: Error) => error.name
      ),
      nextRead().then(() => 'read again'),
    ]);
  return { list, nextRead, outcome };
}

const connectToA = () => {
  apiClient.setConfig({ apiBase: 'http://a.invalid', managementKey: 'fixture-a' });
  return { connectionRevision: apiClient.getConnectionRevision() };
};
const switchToB = () =>
  apiClient.setConfig({ apiBase: 'http://b.invalid', managementKey: 'fixture-b' });

describe('plugin status polling isolation', () => {
  test('does not read again after the connection changes between polls', async () => {
    const scope = connectToA();
    const reads = queueStoreReads();
    const polling = waitForPluginStoreState('demo', 'official', isInstalled, {
      ...scope,
      intervalMs: 0,
    });
    (await reads.nextRead()).resolve(storeResponse(false));
    switchToB();

    expect(await reads.outcome(polling)).toBe('AbortError');
    expect(reads.list).toHaveBeenCalledTimes(1);
  });

  test("does not accept another server's plugin as this installation's completion", async () => {
    const scope = connectToA();
    const reads = queueStoreReads();
    const polling = waitForPluginStoreState('demo', 'official', isInstalled, {
      ...scope,
      intervalMs: 0,
    });
    (await reads.nextRead()).resolve(storeResponse(false));
    const second = await reads.nextRead();
    switchToB();
    second.resolve(storeResponse(true));

    await expect(polling).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('does not start when the connection changed after the scope was captured', async () => {
    const scope = connectToA();
    const reads = queueStoreReads();
    switchToB();

    expect(() => assertPluginConnection(scope)).toThrow();
    const polling = waitForPluginStoreState('demo', 'official', isInstalled, scope);
    expect(await reads.outcome(polling)).toBe('AbortError');
    expect(reads.list).not.toHaveBeenCalled();
  });

  test('stops waiting as soon as the page cancels polling', async () => {
    const scope = connectToA();
    const controller = new AbortController();
    spies.push(
      spyOn(pluginsApi, 'list').mockResolvedValue({
        pluginsEnabled: true,
        plugins: [],
      } as unknown as PluginListResponse)
    );
    const polling = waitForPluginState('demo', () => true, {
      ...scope,
      signal: controller.signal,
      intervalMs: 60_000,
    });
    await new Promise<void>((resolve) => timerStarted.push(resolve));
    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: 'AbortError' });
    expect(pluginsApi.list).toHaveBeenCalledTimes(1);
  });

  test('completes for the connection that started the operation', async () => {
    const scope = connectToA();
    const reads = queueStoreReads();
    const polling = waitForPluginStoreState('demo', 'official', isInstalled, {
      ...scope,
      intervalMs: 0,
    });
    (await reads.nextRead()).resolve(storeResponse(false));
    (await reads.nextRead()).resolve(storeResponse(true));

    const result = await polling;
    expect(result.timedOut).toBe(false);
    expect(result.plugin?.installed).toBe(true);
  });

  test('treats cancellations and old-connection failures as stale', () => {
    const scope = connectToA();
    const cancelled = new DOMException('cancelled', 'AbortError');
    expect(isStalePluginOperation(cancelled, scope)).toBe(true);
    expect(isStalePluginOperation(new Error('failed'), scope)).toBe(false);
    switchToB();
    expect(isStalePluginOperation(new Error('failed'), scope)).toBe(true);
  });

  test('plugin pages scope every mutation and its polling to the page and connection', () => {
    for (const page of ['PluginsPage.tsx', 'PluginStorePage.tsx']) {
      const source = readFileSync(
        new URL(`../src/features/plugins/${page}`, import.meta.url),
        'utf8'
      );
      const scopes = source.match(/const pollScope = getPollScope\(\);/g) ?? [];
      const guardedCacheClears =
        source.match(/assertPluginConnection\(pollScope\);\s+clearConfigCache\(\);/g) ?? [];
      const silentStaleFailures =
        source.match(/if \(isStalePluginOperation\(err, pollScope\)\) return;/g) ?? [];
      expect(scopes.length).toBeGreaterThan(0);
      expect(guardedCacheClears.length).toBe(scopes.length);
      expect(silentStaleFailures.length).toBe(scopes.length);
    }
  });
});
