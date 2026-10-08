import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { clientUsageLimitsApi, normalizeClientUsageLimit } from '@/services/api/clientUsageLimits';
import { clientKeyId } from '@/utils/clientKeyId';

const PATH = '/config/access/api-key-limits';
// Obviously fake fixture keys; ids are derived the way the backend derives them.
const LAPTOP_KEY = 'fixture-key-laptop';
const LAPTOP_ID = clientKeyId(LAPTOP_KEY);
const PHONE_ID = clientKeyId('fixture-key-phone');
const NOT_FOUND = { status: 404, apiCode: 'not_found' };

const spies: Array<{ mockRestore(): void }> = [];
const mock = (method: 'get' | 'put' | 'delete' | 'getConnectionRevision', value?: unknown) => {
  const spy = spyOn(apiClient, method).mockResolvedValue(value as never);
  spies.push(spy);
  return spy;
};
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

describe('client usage limits: read', () => {
  test('keeps only positive finite numbers and trims map keys', async () => {
    const get = mock('get', {
      [LAPTOP_KEY]: 1.5,
      [` ${PHONE_ID} `]: 0.25,
      anonymous: 0.5,
      zero: 0,
      negative: -1,
      text: '2',
      nan: NaN,
      infinite: Infinity,
      '  ': 3,
      nested: { value: 1 },
    });
    expect(await clientUsageLimitsApi.get()).toEqual({
      [LAPTOP_KEY]: 1.5,
      [PHONE_ID]: 0.25,
      anonymous: 0.5,
    });
    expect(get).toHaveBeenCalledWith(PATH);
  });

  test('an absent field is an empty map; other failures propagate', async () => {
    const get = mock('get');
    get.mockRejectedValue(NOT_FOUND);
    expect(await clientUsageLimitsApi.get()).toEqual({});
    for (const error of [{ status: 401 }, { status: 404 }, new Error('network')]) {
      get.mockRejectedValue(error);
      await expect(clientUsageLimitsApi.get()).rejects.toBe(error);
    }
    for (const notAMap of [['not', 'a', 'map'], 'text', 7, null]) {
      get.mockResolvedValue(notAMap);
      expect(await clientUsageLimitsApi.get()).toEqual({});
    }
  });
});

describe('client usage limits: write', () => {
  test('replaces every entry for the id, including a full key that hashes to it', async () => {
    mock('get', { [LAPTOP_KEY]: 1, [LAPTOP_ID]: 2, [PHONE_ID]: 0.25 });
    const put = mock('put');
    const remove = mock('delete');
    await clientUsageLimitsApi.set(LAPTOP_ID, 1.5);
    expect(put).toHaveBeenCalledWith(PATH, { [PHONE_ID]: 0.25, [LAPTOP_ID]: 1.5 });
    // The whole map is written, by id only for the edited key.
    expect(Object.keys(put.mock.calls[0][1] as object)).toEqual([PHONE_ID, LAPTOP_ID]);
    expect(remove).not.toHaveBeenCalled();
  });

  test('rounds to two decimals and leaves other full-key entries as they are', async () => {
    mock('get', { [LAPTOP_KEY]: 1 });
    const put = mock('put');
    await clientUsageLimitsApi.set(PHONE_ID, 0.123456);
    expect(put).toHaveBeenLastCalledWith(PATH, { [LAPTOP_KEY]: 1, [PHONE_ID]: 0.12 });
    await clientUsageLimitsApi.set('anonymous', 0.005);
    expect(put).toHaveBeenLastCalledWith(PATH, { [LAPTOP_KEY]: 1, anonymous: 0.01 });
    await clientUsageLimitsApi.set(` ${PHONE_ID} `, 10);
    expect(put).toHaveBeenLastCalledWith(PATH, { [LAPTOP_KEY]: 1, [PHONE_ID]: 10 });
    expect(normalizeClientUsageLimit(1.234)).toBe(1.23);
    expect(normalizeClientUsageLimit(2)).toBe(2);
    for (const value of [0, 0.004, -2, NaN, Infinity, null, undefined]) {
      expect(normalizeClientUsageLimit(value)).toBeNull();
    }
  });

  test('null, 0 and values that round to 0 remove the entry', async () => {
    const get = mock('get', { [LAPTOP_KEY]: 1, [PHONE_ID]: 0.25 });
    const put = mock('put');
    const remove = mock('delete');
    await clientUsageLimitsApi.set(LAPTOP_ID, null);
    expect(put).toHaveBeenLastCalledWith(PATH, { [PHONE_ID]: 0.25 });
    await clientUsageLimitsApi.set(LAPTOP_ID, 0);
    expect(put).toHaveBeenLastCalledWith(PATH, { [PHONE_ID]: 0.25 });
    await clientUsageLimitsApi.set(LAPTOP_ID, 0.004);
    expect(put).toHaveBeenLastCalledWith(PATH, { [PHONE_ID]: 0.25 });
    expect(put).toHaveBeenCalledTimes(3);
    expect(remove).not.toHaveBeenCalled();
    // Removing an entry that is not there rewrites the map unchanged.
    get.mockResolvedValue({ [PHONE_ID]: 0.25 });
    await clientUsageLimitsApi.set(LAPTOP_ID, null);
    expect(put).toHaveBeenLastCalledWith(PATH, { [PHONE_ID]: 0.25 });
  });

  test('deletes the field once the map is empty and tolerates it being gone already', async () => {
    const get = mock('get', { [LAPTOP_KEY]: 1 });
    const put = mock('put');
    const remove = mock('delete');
    await clientUsageLimitsApi.set(LAPTOP_ID, null);
    expect(remove).toHaveBeenCalledWith(PATH);
    expect(put).not.toHaveBeenCalled();
    // Clearing a limit that is not configured at all is a success.
    get.mockRejectedValue(NOT_FOUND);
    remove.mockRejectedValueOnce(NOT_FOUND);
    await clientUsageLimitsApi.set(PHONE_ID, 0);
    expect(remove).toHaveBeenCalledTimes(2);
    // Any other failure to delete is reported.
    const failure = { status: 500 };
    remove.mockRejectedValueOnce(failure);
    await expect(clientUsageLimitsApi.set(PHONE_ID, null)).rejects.toBe(failure);
    const missingRoute = { status: 404 };
    remove.mockRejectedValueOnce(missingRoute);
    await expect(clientUsageLimitsApi.set(PHONE_ID, null)).rejects.toBe(missingRoute);
    expect(put).not.toHaveBeenCalled();
  });

  test('clear removes every entry for the id and writes nothing when there is none', async () => {
    const get = mock('get', { [LAPTOP_KEY]: 1, [LAPTOP_ID]: 2, [PHONE_ID]: 0.25 });
    const put = mock('put');
    const remove = mock('delete');
    await clientUsageLimitsApi.clear(` ${LAPTOP_ID} `);
    expect(put).toHaveBeenCalledWith(PATH, { [PHONE_ID]: 0.25 });
    get.mockResolvedValue({ [PHONE_ID]: 0.25 });
    await clientUsageLimitsApi.clear(PHONE_ID);
    expect(remove).toHaveBeenCalledWith(PATH);
    // Nothing configured for the key, or no map at all: the config is left untouched.
    get.mockResolvedValue({ [PHONE_ID]: 0.25 });
    await clientUsageLimitsApi.clear(LAPTOP_ID);
    get.mockRejectedValue(NOT_FOUND);
    await clientUsageLimitsApi.clear(LAPTOP_ID);
    expect(put).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(clientUsageLimitsApi.clear('  ')).rejects.toBeInstanceOf(RangeError);
  });

  test('clear runs after a save still in flight, so the save cannot bring the allowance back', async () => {
    let stored: Record<string, number> = { [PHONE_ID]: 0.25 };
    const get = mock('get');
    get.mockImplementation(async () => ({ ...stored }));
    const put = mock('put');
    put.mockImplementation(async (_path: string, map: Record<string, number>) => {
      stored = map;
    });
    const remove = mock('delete');
    remove.mockImplementation(async () => {
      stored = {};
    });
    const save = clientUsageLimitsApi.set(LAPTOP_ID, 1.5);
    await clientUsageLimitsApi.clear(LAPTOP_ID);
    await save;
    expect(stored).toEqual({ [PHONE_ID]: 0.25 });
  });

  test('requires a key id', async () => {
    const get = mock('get');
    const put = mock('put');
    await expect(clientUsageLimitsApi.set('  ', 1)).rejects.toBeInstanceOf(RangeError);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  test('aborts when the connection changes between the read and the write', async () => {
    const revision = spyOn(apiClient, 'getConnectionRevision').mockReturnValue(1);
    spies.push(revision);
    const get = mock('get');
    get.mockImplementation(async () => {
      revision.mockReturnValue(2);
      return { [PHONE_ID]: 0.25 };
    });
    const put = mock('put');
    const remove = mock('delete');
    await expect(clientUsageLimitsApi.set(LAPTOP_ID, 1)).rejects.toMatchObject({
      name: 'AbortError',
    });
    get.mockImplementation(async () => {
      revision.mockReturnValue(3);
      return {};
    });
    await expect(clientUsageLimitsApi.set(LAPTOP_ID, null)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test('writes other entries back exactly as read and matches keys the way the backend does', async () => {
    // Go's strings.TrimSpace keeps U+FEFF and strips U+0085, unlike String.prototype.trim.
    const BOM_KEY = '﻿fixture-key-bom';
    const NEL_KEY = '\u0085fixture-key-nel';
    const PADDED_ID = ` ${LAPTOP_ID} `;
    const get = mock('get', { [BOM_KEY]: 2, zero: 0, [PADDED_ID]: 1, [NEL_KEY]: 3 });
    const put = mock('put');
    await clientUsageLimitsApi.set(PHONE_ID, 1.5);
    expect(put).toHaveBeenLastCalledWith(PATH, {
      [BOM_KEY]: 2,
      zero: 0,
      [PADDED_ID]: 1,
      [NEL_KEY]: 3,
      [PHONE_ID]: 1.5,
    });
    // Editing the id of a full-key entry removes that entry whatever its padding.
    await clientUsageLimitsApi.set(clientKeyId(BOM_KEY), 0.5);
    expect(put).toHaveBeenLastCalledWith(PATH, {
      zero: 0,
      [PADDED_ID]: 1,
      [NEL_KEY]: 3,
      [clientKeyId(BOM_KEY)]: 0.5,
    });
    await clientUsageLimitsApi.set(clientKeyId('fixture-key-nel'), null);
    expect(put).toHaveBeenLastCalledWith(PATH, { [BOM_KEY]: 2, zero: 0, [PADDED_ID]: 1 });
    // A padded id entry is the id, as the backend trims it the same way.
    await clientUsageLimitsApi.set(LAPTOP_ID, null);
    expect(put).toHaveBeenLastCalledWith(PATH, { [BOM_KEY]: 2, zero: 0, [NEL_KEY]: 3 });
    expect(get).toHaveBeenCalledTimes(4);
  });

  test('saves from several rows run one after another, each on the latest map', async () => {
    let server: Record<string, number> = { [LAPTOP_ID]: 1, [PHONE_ID]: 2 };
    const get = mock('get');
    get.mockImplementation(async () => ({ ...server }));
    const put = mock('put');
    put.mockImplementation(async (_path: string, body?: unknown) => {
      server = { ...(body as Record<string, number>) };
    });
    await Promise.all([
      clientUsageLimitsApi.set(LAPTOP_ID, 1.5),
      clientUsageLimitsApi.set(PHONE_ID, 2.5),
      clientUsageLimitsApi.set('anonymous', 0.25),
    ]);
    expect(server).toEqual({ [LAPTOP_ID]: 1.5, [PHONE_ID]: 2.5, anonymous: 0.25 });
    expect(put).toHaveBeenCalledTimes(3);
    // A failed save does not hold up the next one.
    const failure = { status: 500 };
    put.mockRejectedValueOnce(failure);
    const failed = clientUsageLimitsApi.set(LAPTOP_ID, 3);
    const next = clientUsageLimitsApi.set(PHONE_ID, 4);
    await expect(failed).rejects.toBe(failure);
    await next;
    expect(server).toEqual({ [LAPTOP_ID]: 1.5, anonymous: 0.25, [PHONE_ID]: 4 });
  });

  test('a save queued behind another is bound to the connection it was requested on', async () => {
    const revision = spyOn(apiClient, 'getConnectionRevision').mockReturnValue(1);
    spies.push(revision);
    const get = mock('get');
    let reads = 0;
    get.mockImplementation(async () => {
      reads += 1;
      // The connection changes while the first save's read is in flight.
      if (reads === 1) revision.mockReturnValue(2);
      return { [PHONE_ID]: 0.25 };
    });
    const put = mock('put');
    const outcomes = await Promise.allSettled([
      clientUsageLimitsApi.set(LAPTOP_ID, 1),
      clientUsageLimitsApi.set(PHONE_ID, 2),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ name: 'AbortError' });
    }
    expect(put).not.toHaveBeenCalled();
    // Only the first save had to read; the queued one was aborted before reading.
    expect(reads).toBe(1);
  });

  test('a huge value never clears an existing allowance', async () => {
    // Rounding 1e308 to two decimals overflows to Infinity; normalizing must stay
    // finite and idempotent so a second pass cannot turn the value into "clear".
    expect(normalizeClientUsageLimit(1e308)).toBe(1e308);
    expect(normalizeClientUsageLimit(normalizeClientUsageLimit(1e308))).toBe(1e308);
    expect(normalizeClientUsageLimit(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    const get = mock('get', { [LAPTOP_ID]: 1.5 });
    const put = mock('put');
    const remove = mock('delete');
    await clientUsageLimitsApi.set(LAPTOP_ID, 1e308);
    expect(put).toHaveBeenLastCalledWith(PATH, { [LAPTOP_ID]: 1e308 });
    expect(remove).not.toHaveBeenCalled();
    // Non-finite values are refused outright rather than read as "clear".
    for (const value of [Infinity, -Infinity, NaN]) {
      await expect(clientUsageLimitsApi.set(LAPTOP_ID, value)).rejects.toBeInstanceOf(RangeError);
    }
    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
