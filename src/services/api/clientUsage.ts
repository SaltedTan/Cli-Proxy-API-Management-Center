import { apiClient } from './client';
import { clientUsageLimitsApi } from './clientUsageLimits';
import { guardConfigConnection } from './configValue';
import { isRecord } from '@/utils/helpers';
import type {
  ClaudeCredentialRef,
  ClaudeCredentialUsage,
  ClientKeyClaudeCredentialUsage,
  ClientKeyClaudeUsage,
  ClientKeyUsage,
  ClientUsageCounters,
  ClientUsageDay,
  ClientUsageModel,
  ClientUsageSnapshot,
  ClientUsageTokens,
} from '@/types/clientUsage';

const CLIENT_USAGE_TIMEOUT_MS = 15 * 1000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})T/;

const toText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const optionalText = (value: unknown): string | undefined => toText(value) || undefined;

const toCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Fractions and Pro units are non-negative reals. */
const toAmount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** An allowance is only meaningful when positive; anything else means "no limit". */
const toOptionalAmount = (value: unknown): number | null => {
  const amount = toAmount(value);
  return amount > 0 ? amount : null;
};

const toTimeMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  // Go encodes an unset time.Time as year 1; treat it as unknown.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeTokens = (raw: unknown): ClientUsageTokens => {
  const source = isRecord(raw) ? raw : {};
  return {
    input: toCount(source.input_tokens),
    output: toCount(source.output_tokens),
    reasoning: toCount(source.reasoning_tokens),
    cacheRead: toCount(source.cache_read_tokens),
    cacheWrite: toCount(source.cache_write_tokens),
    total: toCount(source.total_tokens),
  };
};

const normalizeCounters = (raw: unknown): ClientUsageCounters => {
  const source = isRecord(raw) ? raw : {};
  return {
    requests: toCount(source.requests),
    failed: toCount(source.failed),
    blocked: toCount(source.blocked),
    tokens: normalizeTokens(source.tokens),
  };
};

const normalizeDay = (raw: unknown): ClientUsageDay | null => {
  if (!isRecord(raw)) return null;
  const date = toText(raw.date);
  if (!DATE_PATTERN.test(date)) return null;
  return { date, ...normalizeCounters(raw) };
};

const normalizeModels = (raw: unknown): ClientUsageModel[] => {
  if (!isRecord(raw)) return [];
  return Object.entries(raw)
    .filter(([model, counters]) => model.trim() && isRecord(counters))
    .map(([model, counters]) => ({ model: model.trim(), ...normalizeCounters(counters) }));
};

const normalizeCredentialRef = (raw: Record<string, unknown>): ClaudeCredentialRef | null => {
  const authId = toText(raw.auth_id);
  if (!authId) return null;
  const planProUnits = toAmount(raw.plan_pro_units);
  return {
    authId,
    authIndex: optionalText(raw.auth_index),
    label: optionalText(raw.label),
    plan: toText(raw.plan).toLowerCase() || 'unknown',
    // The backend never reports a zero allowance; it falls back to 1.
    planProUnits: planProUnits > 0 ? planProUnits : 1,
    planSource: toText(raw.plan_source),
  };
};

const normalizeKeyClaudeCredential = (raw: unknown): ClientKeyClaudeCredentialUsage | null => {
  if (!isRecord(raw)) return null;
  const ref = normalizeCredentialRef(raw);
  if (!ref) return null;
  return {
    ...ref,
    currentFraction: toAmount(raw.current_fraction),
    currentProUnits: toAmount(raw.current_pro_units),
    totalFraction: toAmount(raw.total_fraction),
    totalProUnits: toAmount(raw.total_pro_units),
  };
};

const normalizeKeyClaude = (raw: unknown): ClientKeyClaudeUsage | null => {
  if (!isRecord(raw)) return null;
  const credentials = Array.isArray(raw.credentials)
    ? raw.credentials
        .map(normalizeKeyClaudeCredential)
        .filter((entry): entry is ClientKeyClaudeCredentialUsage => entry !== null)
    : [];
  const currentProUnits = toAmount(raw.current_pro_units);
  const limitProUnits = toOptionalAmount(raw.limit_pro_units);
  const reportedRemaining = raw.remaining_pro_units;
  // Older backends omit the remaining units; derive them from the limit when needed.
  const remainingProUnits =
    limitProUnits === null
      ? null
      : typeof reportedRemaining === 'number' && Number.isFinite(reportedRemaining)
        ? Math.max(reportedRemaining, 0)
        : Math.max(limitProUnits - currentProUnits, 0);
  return {
    currentProUnits,
    totalProUnits: toAmount(raw.total_pro_units),
    windowStartedAtMs: toTimeMs(raw.window_started_at),
    windowResetsAtMs: toTimeMs(raw.window_resets_at),
    limitProUnits,
    remainingProUnits,
    limitReached: raw.limit_reached === true,
    limitResetsAtMs: toTimeMs(raw.limit_resets_at),
    credentials,
  };
};

const normalizeKey = (raw: unknown): ClientKeyUsage | null => {
  if (!isRecord(raw)) return null;
  const id = toText(raw.id);
  if (!id) return null;
  return {
    id,
    name: optionalText(raw.name),
    key: optionalText(raw.key),
    configured: raw.configured === true,
    firstUsedAtMs: toTimeMs(raw.first_used_at),
    lastUsedAtMs: toTimeMs(raw.last_used_at),
    totals: normalizeCounters(raw.totals),
    models: normalizeModels(raw.models),
    daily: Array.isArray(raw.daily)
      ? raw.daily
          .map(normalizeDay)
          .filter((day): day is ClientUsageDay => day !== null)
          .sort((a, b) => a.date.localeCompare(b.date))
      : [],
    claude: normalizeKeyClaude(raw.claude),
  };
};

const normalizeClaudeCredential = (raw: unknown): ClaudeCredentialUsage | null => {
  if (!isRecord(raw)) return null;
  const ref = normalizeCredentialRef(raw);
  if (!ref) return null;
  return {
    ...ref,
    weeklyUtilization: Math.min(1, toAmount(raw.weekly_utilization)),
    windowResetsAtMs: toTimeMs(raw.window_resets_at),
    observedAtMs: toTimeMs(raw.observed_at),
    unattributedCurrentFraction: toAmount(raw.unattributed_current_fraction),
    unattributedTotalFraction: toAmount(raw.unattributed_total_fraction),
  };
};

/**
 * Go encodes `generated_at` with the server's own UTC offset, so its date part is the
 * server-local calendar date that `daily` buckets are keyed by.
 */
const serverDateOf = (value: unknown): string | null => {
  if (toTimeMs(value) === null) return null;
  return TIMESTAMP_DATE_PATTERN.exec(toText(value))?.[1] ?? null;
};

export const normalizeClientUsage = (
  raw: unknown,
  receivedAtMs: number = Date.now()
): ClientUsageSnapshot => {
  const source = isRecord(raw) ? raw : {};
  const seen = new Set<string>();
  const keys = Array.isArray(source.keys)
    ? source.keys.map(normalizeKey).filter((key): key is ClientKeyUsage => {
        if (key === null || seen.has(key.id)) return false;
        seen.add(key.id);
        return true;
      })
    : [];
  const claudeCredentials = Array.isArray(source.claude_credentials)
    ? source.claude_credentials
        .map(normalizeClaudeCredential)
        .filter((entry): entry is ClaudeCredentialUsage => entry !== null)
    : [];
  return {
    generatedAtMs: toTimeMs(source.generated_at),
    receivedAtMs,
    serverDate: serverDateOf(source.generated_at),
    sinceMs: toTimeMs(source.since),
    keys,
    claudeCredentials,
    claudeLimitsSupported: source.claude_limits_supported === true,
  };
};

/** Older backends and CLIProxyAPI Home answer 404 for this endpoint. */
export const isClientUsageUnsupported = (error: unknown): boolean =>
  isRecord(error) && error.status === 404;

export const clientUsageApi = {
  get: async (): Promise<ClientUsageSnapshot> => {
    const raw = await apiClient.get<unknown>('/observability/usage/clients', {
      timeout: CLIENT_USAGE_TIMEOUT_MS,
    });
    return normalizeClientUsage(raw);
  },

  /**
   * Ends the key's current 7-day window: its current usage goes back to zero and the next
   * request opens a fresh window. Totals and daily history are kept. The backend answers
   * 404 for a key it does not know.
   */
  resetWindow: async (keyId: string): Promise<void> => {
    const id = keyId.trim();
    if (!id) throw new RangeError('Client key id is required');
    await apiClient.post(
      `/observability/usage/clients/window/reset?id=${encodeURIComponent(id)}`,
      undefined,
      { timeout: CLIENT_USAGE_TIMEOUT_MS }
    );
  },

  /**
   * Deletes the key's usage history; the backend then lists it only while it is configured
   * or has an allowance. A key the backend does not track (404) has nothing left to delete.
   */
  remove: async (keyId: string): Promise<void> => {
    const id = keyId.trim();
    if (!id) throw new RangeError('Client key id is required');
    try {
      await apiClient.delete(`/observability/usage/clients?id=${encodeURIComponent(id)}`, {
        timeout: CLIENT_USAGE_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(isRecord(error) && error.status === 404)) throw error;
    }
  },

  /**
   * Removes a key from the report: with `clearLimit`, its allowance as configured once any
   * pending allowance save is written (a key that has one stays listed), then its usage
   * history. Bound to the connection it was requested on: if the connection changes while
   * the allowance is cleared, the history is not deleted on the new server.
   */
  removeKey: async (keyId: string, clearLimit: boolean): Promise<void> => {
    const assertConnection = guardConfigConnection();
    if (clearLimit) await clientUsageLimitsApi.clear(keyId);
    assertConnection();
    await clientUsageApi.remove(keyId);
  },
};
