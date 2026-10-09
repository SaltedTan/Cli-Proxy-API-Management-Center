import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { useAuthStore } from '@/stores/useAuthStore';
import { useConfigStore } from '@/stores/useConfigStore';
import type { Config } from '@/types';
import { STORAGE_KEY_AUTH } from '@/utils/constants';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const originalFetchConfig = useConfigStore.getState().fetchConfig;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const memory = new Map<string, string>();
let pendingConfigReads: Array<ReturnType<typeof deferred<Config>>> = [];

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { host: 'proxy.invalid' } },
  });
});
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
beforeEach(() => {
  pendingConfigReads = [];
  useConfigStore.setState({
    fetchConfig: () => {
      const read = deferred<Config>();
      pendingConfigReads.push(read);
      return read.promise;
    },
  });
});
afterEach(() => {
  useConfigStore.setState({ fetchConfig: originalFetchConfig });
  useAuthStore.getState().logout();
  useAuthStore.setState({ rememberPassword: false, connectionStatus: 'disconnected' });
  memory.clear();
});

const connectionA = {
  apiBase: 'https://a.invalid',
  managementKey: 'fixture-key-a',
  rememberPassword: true,
};
const connectionB = {
  apiBase: 'https://b.invalid',
  managementKey: 'fixture-key-b',
  rememberPassword: false,
};

const persistedAuth = () =>
  obfuscatedStorage.getItem<{ state?: Record<string, unknown> }>(STORAGE_KEY_AUTH)?.state ?? {};

describe('auth session isolation', () => {
  test('a login that completes after logout does not restore the session', async () => {
    const login = useAuthStore.getState().login(connectionA);
    useAuthStore.getState().logout();
    pendingConfigReads[0].resolve({} as Config);

    await expect(login).rejects.toMatchObject({ name: 'AbortError' });
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.managementKey).toBe('');
    expect(state.connectionStatus).toBe('disconnected');
    expect(persistedAuth().managementKey).toBeUndefined();
    expect(memory.get('isLoggedIn')).toBeUndefined();
  });

  test('an older login does not overwrite a newer one', async () => {
    const loginA = useAuthStore.getState().login(connectionA);
    const loginB = useAuthStore.getState().login(connectionB);
    pendingConfigReads[1].resolve({} as Config);
    await loginB;
    pendingConfigReads[0].resolve({} as Config);
    await expect(loginA).rejects.toMatchObject({ name: 'AbortError' });

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.apiBase).toBe(connectionB.apiBase);
    expect(state.managementKey).toBe(connectionB.managementKey);
    expect(state.rememberPassword).toBe(false);
    expect(persistedAuth().managementKey).toBeUndefined();
    expect(memory.get('isLoggedIn')).toBeUndefined();
  });

  test('an obsolete login failure does not mark the new session as failed', async () => {
    const loginA = useAuthStore.getState().login(connectionA);
    const loginB = useAuthStore.getState().login(connectionB);
    pendingConfigReads[1].resolve({} as Config);
    await loginB;
    const error = Object.assign(new Error('unavailable'), { status: 503 });
    pendingConfigReads[0].reject(error);

    await expect(loginA).rejects.toBe(error);
    expect(useAuthStore.getState().connectionStatus).toBe('connected');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  test('checkAuth ignores a success or failure that arrives after logout', async () => {
    useAuthStore.setState({ apiBase: connectionA.apiBase, managementKey: 'fixture-key-a' });
    const succeeded = useAuthStore.getState().checkAuth();
    useAuthStore.getState().logout();
    pendingConfigReads[0].resolve({} as Config);
    expect(await succeeded).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().connectionStatus).toBe('disconnected');

    useAuthStore.setState({ apiBase: connectionA.apiBase, managementKey: 'fixture-key-a' });
    const failed = useAuthStore.getState().checkAuth();
    useAuthStore.getState().logout();
    pendingConfigReads[1].reject(new Error('unavailable'));
    expect(await failed).toBe(false);
    expect(useAuthStore.getState().connectionStatus).toBe('disconnected');
  });

  test('checkAuth still authenticates the current connection', async () => {
    useAuthStore.setState({ apiBase: connectionA.apiBase, managementKey: 'fixture-key-a' });
    const check = useAuthStore.getState().checkAuth();
    pendingConfigReads[0].resolve({} as Config);
    expect(await check).toBe(true);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});

describe('legacy management key storage', () => {
  const writeLegacyKey = () => obfuscatedStorage.setItem('managementKey', 'fixture-legacy-key');

  test('a non-remembered login and logout delete the legacy key', async () => {
    writeLegacyKey();
    const login = useAuthStore.getState().login(connectionB);
    pendingConfigReads[0].resolve({} as Config);
    await login;
    expect(memory.has('managementKey')).toBe(false);

    writeLegacyKey();
    useAuthStore.getState().logout();
    expect(memory.has('managementKey')).toBe(false);
  });

  test('restoreSession drops a legacy key without a logged-in legacy session', async () => {
    writeLegacyKey();
    obfuscatedStorage.setItem('apiBase', 'https://legacy.invalid');

    expect(await useAuthStore.getState().restoreSession()).toBe(false);
    const state = useAuthStore.getState();
    expect(state.managementKey).toBe('');
    expect(state.rememberPassword).toBe(false);
    expect(state.apiBase).toBe('https://legacy.invalid');
    expect(memory.has('managementKey')).toBe(false);
    expect(memory.has('apiBase')).toBe(false);
    expect(persistedAuth().managementKey).toBeUndefined();
  });

  test('restoreSession migrates the key of a logged-in legacy session once', async () => {
    writeLegacyKey();
    obfuscatedStorage.setItem('apiBase', 'https://legacy.invalid');
    memory.set('isLoggedIn', 'true');

    const restored = useAuthStore.getState().restoreSession();
    expect(memory.has('managementKey')).toBe(false);
    pendingConfigReads[0].resolve({} as Config);
    expect(await restored).toBe(true);

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.managementKey).toBe('fixture-legacy-key');
    expect(state.rememberPassword).toBe(true);
    expect(persistedAuth().managementKey).toBe('fixture-legacy-key');
  });
});
