import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { QUOTA_ADAPTERS } from '@/features/quota/providers';
import { runQuotaReset } from '@/features/quota/quotaReset';
import { apiCallApi, apiClient, authFilesApi } from '@/services/api';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { NotificationType } from '@/types';
import { CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';

const t = ((key: string) => key) as TFunction;
const file = { name: 'codex-test.json', auth_index: 'test-index', type: 'codex' };
const adapter = QUOTA_ADAPTERS.codex;
const response = (body: unknown, statusCode = 200) => ({
  statusCode,
  body,
  bodyText: JSON.stringify(body),
  header: {},
});
const mocks: Array<{ mockRestore(): void }> = [];

function setup({ changeConnectionOnRead = false, readStatus = 200 } = {}) {
  let revision = 1;
  mocks.push(spyOn(apiClient, 'getConnectionRevision').mockImplementation(() => revision));
  mocks.push(
    spyOn(apiCallApi, 'request').mockImplementation(async (payload) => {
      if (payload.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL) {
        return response({ code: 'reset' });
      }
      // The quota read follows the cooldown clear.
      if (changeConnectionOnRead) revision += 1;
      return response({}, readStatus);
    })
  );
  const clear = spyOn(authFilesApi, 'resetCooldown').mockResolvedValue({
    status: 'ok',
    auth_index: 'test-index',
    models: [],
  });
  mocks.push(clear);
  const notices: NotificationType[] = [];
  const messages: string[] = [];
  let reloads = 0;
  const run = () =>
    runQuotaReset(
      adapter,
      file,
      t,
      (message, type) => {
        messages.push(message);
        notices.push(type);
      },
      () => {
        reloads += 1;
      }
    );
  return { clear, messages, notices, reloads: () => reloads, run };
}

beforeEach(() => {
  useQuotaStore.getState().clearQuotaCache();
});

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
  useQuotaStore.getState().clearQuotaCache();
});

describe('runQuotaReset', () => {
  test('reloads the auth-file listing once the cooldown clear is confirmed', async () => {
    const { clear, notices, reloads, run } = setup();
    await run();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(reloads()).toBe(1);
    expect(notices).toEqual(['success']);
    expect(useQuotaStore.getState().codexQuota[getQuotaCacheKey(file)]?.status).toBe('success');
  });

  test('discards the result when the connection changed during the reset', async () => {
    const { clear, notices, reloads, run } = setup({ changeConnectionOnRead: true });
    await run();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(reloads()).toBe(0);
    expect(notices).toEqual([]);
    expect(useQuotaStore.getState().codexQuota[getQuotaCacheKey(file)]).toBeUndefined();
  });

  test('reports the reset and reloads the listing when only the quota read after it fails', async () => {
    const { clear, messages, notices, reloads, run } = setup({ readStatus: 503 });
    await run();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(reloads()).toBe(1);
    expect(notices).toEqual(['warning']);
    expect(messages).toEqual(['codex_quota.reset_success_refresh_failed']);
    const quota = useQuotaStore.getState().codexQuota[getQuotaCacheKey(file)];
    expect(quota?.status).toBe('error');
    expect(quota?.errorStatus).toBe(503);
  });

  test('discards a failed read after the reset when the connection changed', async () => {
    const { notices, reloads, run } = setup({ changeConnectionOnRead: true, readStatus: 503 });
    await run();
    expect(reloads()).toBe(0);
    expect(notices).toEqual([]);
    expect(useQuotaStore.getState().codexQuota[getQuotaCacheKey(file)]).toBeUndefined();
  });

  test('does not reload when the cooldown clear failed', async () => {
    const { clear, notices, reloads, run } = setup();
    clear.mockRejectedValue(new Error('offline'));
    await run();
    expect(reloads()).toBe(0);
    expect(notices).toEqual(['error']);
  });
});
