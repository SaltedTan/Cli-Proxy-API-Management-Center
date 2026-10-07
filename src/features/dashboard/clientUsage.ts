import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { TFunction } from 'i18next';
import { apiKeyNameFingerprint } from '@/features/config/apiKeyNames';
import type {
  ClientKeyClaudeCredentialUsage,
  ClientKeyUsage,
  ClientUsageDay,
  ClientUsageModel,
  ClientUsageSnapshot,
} from '@/types/clientUsage';
import { formatPercent } from '@/utils/format';
import { DAY_MS } from '@/utils/time/durations';
import type { MeterTone } from './utils';

/** Requests without a client API key are grouped under this id. */
export const ANONYMOUS_CLIENT_KEY_ID = 'anonymous';

/** Tokens and requests are summarized over this many server-local days, today included. */
export const CLIENT_USAGE_WINDOW_DAYS = 7;

const TOP_MODEL_COUNT = 3;

// Go's strings.TrimSpace (unicode.IsSpace). Unlike String.prototype.trim it strips U+0085
// and keeps U+FEFF, so key ids match the backend for every configured key.
const GO_SPACE =
  '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'g');

/**
 * The backend's `KeyID`: the first 8 bytes of the SHA-256 of the trimmed key as 16
 * lowercase hex characters, or `anonymous` for an empty key.
 */
export function clientKeyId(rawKey: string): string {
  const key = rawKey.replace(GO_TRIM, '');
  if (!key) return ANONYMOUS_CLIENT_KEY_ID;
  return bytesToHex(sha256(new TextEncoder().encode(key)).subarray(0, 8));
}

/**
 * Maps key ids to the names the API keys editor saved in this browser. The editor
 * fingerprints each trimmed key per server, so the ids are derived from the same values.
 */
export function buildLocalKeyNames(
  apiBase: string,
  configuredKeys: readonly string[],
  storedNames: Readonly<Record<string, string>>
): Map<string, string> {
  const names = new Map<string, string>();
  configuredKeys.forEach((rawKey) => {
    const key = rawKey.trim();
    if (!key) return;
    const name = storedNames[apiKeyNameFingerprint(apiBase, key)]?.trim();
    const id = clientKeyId(key);
    if (name && !names.has(id)) names.set(id, name);
  });
  return names;
}

export type ClientKeyLabelSource = 'config' | 'local' | 'anonymous' | 'key' | 'id';

export interface ClientKeyLabel {
  text: string;
  source: ClientKeyLabelSource;
}

/**
 * Display name precedence: the backend name (`access.api-key-names`), then the name
 * saved in this browser, then the masked key, then the id.
 */
export function clientKeyLabel(
  entry: Pick<ClientKeyUsage, 'id' | 'name' | 'key'>,
  localNames: ReadonlyMap<string, string>,
  anonymousLabel: string
): ClientKeyLabel {
  if (entry.name) return { text: entry.name, source: 'config' };
  const local = localNames.get(entry.id);
  if (local) return { text: local, source: 'local' };
  if (entry.id === ANONYMOUS_CLIENT_KEY_ID) return { text: anonymousLabel, source: 'anonymous' };
  if (entry.key) return { text: entry.key, source: 'key' };
  return { text: entry.id, source: 'id' };
}

const shiftDate = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Browser-local `YYYY-MM-DD`; a fallback when the server date is unknown. */
export function localDateOf(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The date `daily` buckets are compared against. */
export function clientUsageToday(snapshot: ClientUsageSnapshot, nowMs: number): string {
  return snapshot.serverDate ?? localDateOf(snapshot.generatedAtMs ?? nowMs);
}

export interface ClientUsageWindowTotals {
  requests: number;
  failed: number;
  tokens: number;
}

/** Sums the `days` most recent calendar days ending at `today`. */
export function summarizeRecentDays(
  daily: readonly ClientUsageDay[],
  today: string,
  days = CLIENT_USAGE_WINDOW_DAYS
): ClientUsageWindowTotals {
  const from = shiftDate(today, -(days - 1));
  return daily.reduce<ClientUsageWindowTotals>(
    (totals, day) => {
      if (day.date < from || day.date > today) return totals;
      return {
        requests: totals.requests + day.requests,
        failed: totals.failed + day.failed,
        tokens: totals.tokens + day.tokens.total,
      };
    },
    { requests: 0, failed: 0, tokens: 0 }
  );
}

/** Whether a key has served or attempted anything since tracking started. */
export const clientKeyHasUsage = (entry: ClientKeyUsage): boolean =>
  entry.lastUsedAtMs !== null || entry.totals.requests + entry.totals.failed > 0;

export function topModels(
  models: readonly ClientUsageModel[],
  count = TOP_MODEL_COUNT
): ClientUsageModel[] {
  return models
    .filter((model) => model.tokens.total > 0 || model.requests + model.failed > 0)
    .sort(
      (a, b) =>
        b.tokens.total - a.tokens.total || b.requests - a.requests || a.model.localeCompare(b.model)
    )
    .slice(0, count);
}

export interface ClientUsageRow {
  id: string;
  label: ClientKeyLabel;
  /** Masked key or id to show under a friendlier name; absent when it would repeat. */
  secondary?: string;
  configured: boolean;
  anonymous: boolean;
  used: boolean;
  lastUsedAtMs: number | null;
  week: ClientUsageWindowTotals;
  /** Null when the key never used a Claude subscription. */
  claudeCurrentProUnits: number | null;
  claudeTotalProUnits: number;
  /** Share of all keys' Claude Pro units this week, 0–1; null without Claude usage. */
  claudeShare: number | null;
  claudeCredentials: ClientKeyClaudeCredentialUsage[];
  topModels: ClientUsageModel[];
}

export interface ClientUsageRowOptions {
  localNames: ReadonlyMap<string, string>;
  anonymousLabel: string;
  today: string;
}

/**
 * One row per key, heaviest Claude users first, then by 7-day tokens and name.
 * Configured keys that were never used go last.
 */
export function buildClientUsageRows(
  keys: readonly ClientKeyUsage[],
  { localNames, anonymousLabel, today }: ClientUsageRowOptions
): ClientUsageRow[] {
  const rows = keys.map<ClientUsageRow>((entry) => {
    const label = clientKeyLabel(entry, localNames, anonymousLabel);
    const nameShown = label.source === 'config' || label.source === 'local';
    return {
      id: entry.id,
      label,
      secondary: nameShown ? entry.key || entry.id : undefined,
      configured: entry.configured,
      anonymous: entry.id === ANONYMOUS_CLIENT_KEY_ID,
      used: clientKeyHasUsage(entry),
      lastUsedAtMs: entry.lastUsedAtMs,
      week: summarizeRecentDays(entry.daily, today),
      claudeCurrentProUnits: entry.claude ? entry.claude.currentProUnits : null,
      claudeTotalProUnits: entry.claude?.totalProUnits ?? 0,
      claudeShare: null,
      claudeCredentials: [...(entry.claude?.credentials ?? [])].sort(
        (a, b) =>
          b.currentProUnits - a.currentProUnits ||
          b.totalProUnits - a.totalProUnits ||
          (a.label || a.authId).localeCompare(b.label || b.authId)
      ),
      topModels: topModels(entry.models),
    };
  });

  const claudeTotal = rows.reduce((sum, row) => sum + (row.claudeCurrentProUnits ?? 0), 0);
  if (claudeTotal > 0) {
    rows.forEach((row) => {
      if (row.claudeCurrentProUnits !== null) {
        row.claudeShare = row.claudeCurrentProUnits / claudeTotal;
      }
    });
  }

  return rows.sort(
    (a, b) =>
      Number(b.used) - Number(a.used) ||
      (b.claudeCurrentProUnits ?? 0) - (a.claudeCurrentProUnits ?? 0) ||
      b.week.tokens - a.week.tokens ||
      a.label.text.localeCompare(b.label.text) ||
      a.id.localeCompare(b.id)
  );
}

export type ClientUsageHint =
  { kind: 'no-keys' } | { kind: 'shared-key' } | { kind: 'removed-keys'; count: number };

/** Nudges toward one key per device, and flags usage from keys that left the config. */
export function clientUsageHints(keys: readonly ClientKeyUsage[]): ClientUsageHint[] {
  const hints: ClientUsageHint[] = [];
  const configured = keys.filter((entry) => entry.configured);
  const anonymous = keys.find((entry) => entry.id === ANONYMOUS_CLIENT_KEY_ID);
  if (configured.length === 0 && anonymous && clientKeyHasUsage(anonymous)) {
    hints.push({ kind: 'no-keys' });
  }
  if (configured.length === 1 && clientKeyHasUsage(configured[0])) {
    hints.push({ kind: 'shared-key' });
  }
  const removed = keys.filter(
    (entry) => !entry.configured && entry.id !== ANONYMOUS_CLIENT_KEY_ID && clientKeyHasUsage(entry)
  ).length;
  if (removed > 0) hints.push({ kind: 'removed-keys', count: removed });
  return hints;
}

const PLAN_LABEL_KEYS: Record<string, string> = {
  pro: 'claude_quota.plan_pro',
  team: 'claude_quota.plan_team',
  max_5x: 'claude_quota.plan_max5',
  max_20x: 'claude_quota.plan_max20',
  unknown: 'dashboard.client_usage_plan_unknown',
};

/** `enterprise` → `Enterprise`, `claude_edu-plus` → `Claude Edu Plus`. */
export const titleCasePlan = (plan: string): string =>
  plan
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** Plan name, noting when its allowance comes from the credential weight. */
export function claudePlanLabel(t: TFunction, plan: string, planSource: string): string {
  const key = PLAN_LABEL_KEYS[plan];
  const label = key ? t(key) : titleCasePlan(plan) || t('dashboard.client_usage_plan_unknown');
  return planSource === 'weight'
    ? t('dashboard.client_usage_plan_by_weight', { plan: label })
    : label;
}

/** `0.84`, `2.31`, `12.5`: two decimals below 10 units, one above. */
export function formatProUnits(value: number, locale?: string): string {
  const digits = value >= 10 ? 1 : 2;
  return value.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Plan allowances are exact (`1`, `1.25`, `10`). */
export function formatPlanAllowance(value: number, locale?: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}

/** Fractions of a weekly limit, keeping one decimal for small values. */
export function formatLimitFraction(fraction: number): string {
  const percent = fraction * 100;
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return formatPercent(percent, percent < 10 ? 1 : 0);
}

/** Closer to the weekly limit is worse. */
export function weeklyUtilizationTone(fraction: number): MeterTone {
  if (fraction >= 0.9) return 'critical';
  if (fraction >= 0.7) return 'warning';
  return 'good';
}
