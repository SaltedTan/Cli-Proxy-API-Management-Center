/**
 * `access.api-key-limits`: each client API key's Claude allowance in Pro units per weekly
 * window. Entries are keyed by key id (first 16 hex characters of the key's SHA-256) or
 * by full key; a full-key entry wins. The panel only ever writes ids.
 */
import { apiClient } from './client';
import { getConfigValue, guardConfigConnection, isMissingConfigValue } from './configValue';
import { clientKeyId, trimSpaceLikeGo } from '@/utils/clientKeyId';
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

/** The map as stored, with every entry as the backend returned it. */
const readRawLimits = async (): Promise<Record<string, unknown>> => {
  const raw = await getConfigValue<unknown>(PATH, {});
  return isRecord(raw) ? raw : {};
};

/**
 * Whether a configured entry, by id or by full key, applies to `keyId`. Keys are trimmed
 * the way the backend trims them (Go's strings.TrimSpace, not String.prototype.trim)
 * so the match agrees with the ids the usage report shows.
 */
const resolvesTo = (entryKey: string, keyId: string): boolean => {
  const trimmed = trimSpaceLikeGo(entryKey);
  return trimmed === keyId || clientKeyId(trimmed) === keyId;
};

/**
 * Replaces every entry for `id` and writes the whole map back. Entries for other keys
 * are written exactly as read, zero values and untrimmed keys included, so a save never
 * alters another operator's configuration.
 */
const writeLimit = async (id: string, value: number | null): Promise<void> => {
  const assertConnection = guardConfigConnection();
  const raw = await readRawLimits();
  assertConnection();
  const entries = Object.entries(raw).filter(([entryKey]) => !resolvesTo(entryKey, id));
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
};

// Saves are read-modify-write of the whole map, so they run one after another: each
// reads the map only after the previous save (from any row) has been written.
let lastWrite: Promise<unknown> = Promise.resolve();

export const clientUsageLimitsApi = {
  async get(): Promise<ClientUsageLimits> {
    const limits: ClientUsageLimits = {};
    for (const [name, value] of Object.entries(await readRawLimits())) {
      const key = name.trim();
      const limit = toLimit(value);
      if (key && limit !== null) limits[key] = limit;
    }
    return limits;
  },

  /** Sets or, with `null`/`0`, removes the allowance of the key with id `keyId`. */
  async set(keyId: string, value: number | null): Promise<void> {
    const id = keyId.trim();
    if (!id) throw new RangeError('Client key id is required');
    const write = lastWrite.then(() => writeLimit(id, value));
    lastWrite = write.catch(() => undefined);
    return write;
  },
};
