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

/**
 * Rounds to two decimals; null for anything that does not set a limit (blank, 0, NaN,
 * negative). Always finite and idempotent: a value too large to round stays as it is,
 * so normalizing twice can never turn a limit into "clear".
 */
export const normalizeClientUsageLimit = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  const limit = Number.isFinite(rounded) ? rounded : value;
  return limit > 0 ? limit : null;
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
 * alters another operator's configuration. `assertConnection` was captured when the save
 * was requested and aborts it before reading and before writing if the connection changed.
 * With `onlyIfConfigured`, a map without an entry for `id` is left as it is.
 */
const writeLimit = async (
  id: string,
  value: number | null,
  assertConnection: () => void,
  onlyIfConfigured = false
): Promise<void> => {
  assertConnection();
  const raw = await readRawLimits();
  assertConnection();
  const entries = Object.entries(raw).filter(([entryKey]) => !resolvesTo(entryKey, id));
  if (onlyIfConfigured && entries.length === Object.keys(raw).length) return;
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

const enqueueWrite = (
  keyId: string,
  value: number | null,
  onlyIfConfigured: boolean
): Promise<void> => {
  const id = keyId.trim();
  if (!id) throw new RangeError('Client key id is required');
  // Bound to the connection the save was requested on, even while it waits its turn.
  const assertConnection = guardConfigConnection();
  const write = lastWrite.then(() => writeLimit(id, value, assertConnection, onlyIfConfigured));
  lastWrite = write.catch(() => undefined);
  return write;
};

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
    // Only null (or a value that rounds to 0) clears; a non-finite number is a bug.
    if (value !== null && !Number.isFinite(value)) {
      throw new RangeError('Client key allowance must be a finite number');
    }
    return enqueueWrite(keyId, value, false);
  },

  /**
   * Removes the allowance of the key with id `keyId` as configured once every pending save
   * has been written, so a save still in flight cannot bring it back; writes nothing when
   * the key has none.
   */
  async clear(keyId: string): Promise<void> {
    return enqueueWrite(keyId, null, true);
  },
};
