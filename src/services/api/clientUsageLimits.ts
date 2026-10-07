/**
 * `access.api-key-limits`: each client API key's Claude allowance in Pro units per weekly
 * window. Entries are keyed by key id (first 16 hex characters of the key's SHA-256) or
 * by full key; a full-key entry wins. The panel only ever writes ids.
 */
import { apiClient } from './client';
import { getConfigValue, guardConfigConnection, isMissingConfigValue } from './configValue';
import { clientKeyId } from '@/utils/clientKeyId';
import { isRecord } from '@/utils/helpers';

const PATH = '/config/access/api-key-limits';

/** Limits by map key as configured (ids and full keys alike); only positive values. */
export type ClientUsageLimits = Record<string, number>;

const toLimit = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** Rounds to two decimals; null for anything that does not set a limit (blank, 0, NaN, negative). */
export const normalizeClientUsageLimit = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? rounded : null;
};

const readLimits = async (): Promise<Array<[string, number]>> => {
  const raw = await getConfigValue<unknown>(PATH, {});
  if (!isRecord(raw)) return [];
  const entries: Array<[string, number]> = [];
  for (const [name, value] of Object.entries(raw)) {
    const key = name.trim();
    const limit = toLimit(value);
    if (key && limit !== null) entries.push([key, limit]);
  }
  return entries;
};

/** Whether a map entry, by id or by full key, applies to `keyId`. */
const resolvesTo = (entryKey: string, keyId: string): boolean =>
  entryKey === keyId || clientKeyId(entryKey) === keyId;

export const clientUsageLimitsApi = {
  async get(): Promise<ClientUsageLimits> {
    return Object.fromEntries(await readLimits());
  },

  /** Sets or, with `null`/`0`, removes the allowance of the key with id `keyId`. */
  async set(keyId: string, value: number | null): Promise<void> {
    const id = keyId.trim();
    if (!id) throw new RangeError('Client key id is required');
    const assertConnection = guardConfigConnection();
    const current = await readLimits();
    assertConnection();
    const entries = current.filter(([entryKey]) => !resolvesTo(entryKey, id));
    const limit = normalizeClientUsageLimit(value);
    if (limit !== null) entries.push([id, limit]);
    if (entries.length > 0) {
      await apiClient.put(PATH, Object.fromEntries(entries));
      return;
    }
    try {
      await apiClient.delete(PATH);
    } catch (error) {
      // The field was already absent, which is the state being asked for.
      if (!isMissingConfigValue(error)) throw error;
    }
  },
};
