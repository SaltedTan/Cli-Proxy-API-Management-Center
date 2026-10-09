import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { apiClient } from '@/services/api/client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let events: Event[] = [];

beforeEach(() => {
  events = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
    },
  });
});
afterEach(() => {
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const versionHeaders = { 'x-cpa-version': 'v8.0.1', 'x-cpa-support-plugin': 'true' };

/** Holds every request until the test releases it, so responses can arrive after a switch. */
function heldAdapter(status: number) {
  const sent = deferred<void>();
  const release = deferred<void>();
  const adapter: AxiosAdapter = async (config) => {
    sent.resolve();
    await release.promise;
    const response: AxiosResponse = {
      data: {},
      status,
      statusText: String(status),
      headers: versionHeaders,
      config,
    };
    if (status >= 400) {
      throw new AxiosError('failed', 'ERR_BAD_REQUEST', config, null, response);
    }
    return response;
  };
  return { adapter, sent: sent.promise, release: () => release.resolve() };
}

describe('API client connection events', () => {
  test('a 401 from an older connection does not log out the new one', async () => {
    apiClient.setConfig({ apiBase: 'http://a.invalid', managementKey: 'fixture-a' });
    const held = heldAdapter(401);
    const request = apiClient.get('/config', { adapter: held.adapter });
    await held.sent;
    apiClient.setConfig({ apiBase: 'http://b.invalid', managementKey: 'fixture-b' });
    held.release();

    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(events.map((event) => event.type)).toEqual([]);
  });

  test('success headers from an older connection do not update server metadata', async () => {
    apiClient.setConfig({ apiBase: 'http://a.invalid', managementKey: 'fixture-a' });
    const held = heldAdapter(200);
    const request = apiClient.get('/config', { adapter: held.adapter });
    await held.sent;
    apiClient.setConfig({ apiBase: '', managementKey: '' });
    held.release();

    await expect(request).resolves.toEqual({});
    expect(events).toEqual([]);
  });

  test('responses from the current connection still publish their events', async () => {
    apiClient.setConfig({ apiBase: 'http://a.invalid', managementKey: 'fixture-a' });
    const ok = heldAdapter(200);
    const success = apiClient.get('/config', { adapter: ok.adapter });
    ok.release();
    await success;
    const denied = heldAdapter(401);
    const failure = apiClient.get('/config', { adapter: denied.adapter });
    denied.release();
    await expect(failure).rejects.toMatchObject({ status: 401 });

    expect(events.map((event) => event.type)).toEqual([
      'server-version-update',
      'server-plugin-support-update',
      'unauthorized',
    ]);
  });
});
