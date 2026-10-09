import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { refreshProviderConfig } from '@/features/providers/refreshProviderConfig';
import { apiClient } from '@/services/api/client';
import { providersApi } from '@/services/api/providers';
import type { OpenAIProviderConfig, ProviderKeyConfig } from '@/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

function startRefresh() {
  const config = deferred<unknown>();
  const vertex = deferred<ProviderKeyConfig[]>();
  const openai = deferred<OpenAIProviderConfig[]>();
  spies.push(spyOn(providersApi, 'getVertexConfigs').mockReturnValue(vertex.promise));
  spies.push(spyOn(providersApi, 'getOpenAIProviders').mockReturnValue(openai.promise));
  const updates: string[] = [];
  const revision = apiClient.getConnectionRevision();
  const refresh = refreshProviderConfig({
    fetchConfig: () => config.promise,
    updateConfigValue: (section) => updates.push(section),
    isCurrent: () => revision === apiClient.getConnectionRevision(),
  });
  return { config, vertex, openai, updates, refresh };
}

describe('provider refresh session isolation', () => {
  test('drops provider lists read from a connection that was replaced', async () => {
    apiClient.setConfig({ apiBase: 'http://a.invalid', managementKey: 'fixture-a' });
    const run = startRefresh();
    run.vertex.resolve([{ apiKey: 'fixture-a-vertex' } as ProviderKeyConfig]);
    run.openai.resolve([]);
    apiClient.setConfig({ apiBase: 'http://b.invalid', managementKey: 'fixture-b' });
    run.config.resolve({});

    expect(await run.refresh).toBe(false);
    expect(run.updates).toEqual([]);
  });

  test('does not report a failure from a replaced connection', async () => {
    apiClient.setConfig({ apiBase: 'http://a.invalid', managementKey: 'fixture-a' });
    const run = startRefresh();
    apiClient.setConfig({ apiBase: '', managementKey: '' });
    run.config.reject(new Error('unauthorized'));
    run.vertex.resolve([]);
    run.openai.resolve([]);

    expect(await run.refresh).toBe(false);
  });

  test('publishes provider lists for the current connection', async () => {
    apiClient.setConfig({ apiBase: 'http://a.invalid', managementKey: 'fixture-a' });
    const run = startRefresh();
    run.config.resolve({});
    run.vertex.resolve([]);
    run.openai.resolve([]);

    expect(await run.refresh).toBe(true);
    expect(run.updates).toEqual(['vertex-api-key', 'openai-compatibility']);
  });

  test('the workbench scopes each refresh to its request and connection', () => {
    const source = readFileSync(
      new URL('../src/features/providers/useProviderWorkbench.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain(
      'refreshProviderConfig({ fetchConfig, updateConfigValue, isCurrent })'
    );
    expect(source).toContain('revision === apiClient.getConnectionRevision()');
    expect(source).not.toContain('providersApi.getVertexConfigs()');
  });
});
