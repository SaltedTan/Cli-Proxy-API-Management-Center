import { apiClient } from './client';
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
    windowResetsAtMs: toTimeMs(raw.window_resets_at),
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
  return {
    currentProUnits: toAmount(raw.current_pro_units),
    totalProUnits: toAmount(raw.total_pro_units),
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

export const normalizeClientUsage = (raw: unknown): ClientUsageSnapshot => {
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
    serverDate: serverDateOf(source.generated_at),
    sinceMs: toTimeMs(source.since),
    keys,
    claudeCredentials,
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
};
