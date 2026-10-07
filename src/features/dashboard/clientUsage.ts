import type { TFunction } from 'i18next';
import { apiKeyNameFingerprint } from '@/features/config/apiKeyNames';
import { normalizeClientUsageLimit } from '@/services/api/clientUsageLimits';
import type {
  ClientKeyClaudeCredentialUsage,
  ClientKeyClaudeUsage,
  ClientKeyUsage,
  ClientUsageDay,
  ClientUsageModel,
  ClientUsageSnapshot,
} from '@/types/clientUsage';
import { ANONYMOUS_CLIENT_KEY_ID, clientKeyId } from '@/utils/clientKeyId';
import { formatPercent } from '@/utils/format';
import { DAY_MS } from '@/utils/time/durations';
import type { MeterTone } from './utils';

export { ANONYMOUS_CLIENT_KEY_ID, clientKeyId };

/** Tokens and requests are summarized over this many server-local days, today included. */
export const CLIENT_USAGE_WINDOW_DAYS = 7;

const TOP_MODEL_COUNT = 3;

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
  /** Refused by the key's Claude allowance. */
  blocked: number;
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
        blocked: totals.blocked + day.blocked,
        tokens: totals.tokens + day.tokens.total,
      };
    },
    { requests: 0, failed: 0, blocked: 0, tokens: 0 }
  );
}

/** Whether a key has served, attempted or been refused anything since tracking started. */
export const clientKeyHasUsage = (entry: ClientKeyUsage): boolean =>
  entry.lastUsedAtMs !== null ||
  entry.totals.requests + entry.totals.failed + entry.totals.blocked > 0;

/**
 * The backend reports `claude` for keys with Claude usage or a configured limit; only the
 * former should read as Claude usage.
 */
const claudeUsed = (claude: ClientKeyClaudeUsage | null): claude is ClientKeyClaudeUsage =>
  claude !== null &&
  (claude.currentProUnits > 0 || claude.totalProUnits > 0 || claude.credentials.length > 0);

/** A key's open 7-day window. */
export interface ClaudeWindowStatus {
  /** Null on backends that report only the reset instant. */
  startedAtMs: number | null;
  resetsAtMs: number;
}

/** Null while the key has no open window (never used Claude, idle past its last window, or reset). */
export function claudeWindowStatus(
  claude: ClientKeyClaudeUsage | null,
  nowMs: number
): ClaudeWindowStatus | null {
  if (!claude || claude.windowResetsAtMs === null || claude.windowResetsAtMs <= nowMs) {
    return null;
  }
  return { startedAtMs: claude.windowStartedAtMs, resetsAtMs: claude.windowResetsAtMs };
}

export interface ClaudeLimitStatus {
  /** Configured allowance in Pro units per 7-day window. */
  limit: number;
  /** Pro units used in the key's current window. */
  used: number;
  remaining: number;
  /** `used / limit`, capped at 1. */
  fraction: number;
  /** The proxy is refusing this key's Claude requests. */
  reached: boolean;
  /** When the key's window resets; null when unknown or already passed. */
  resetsAtMs: number | null;
}

/** Null without a configured limit. A reset instant that has passed is treated as unknown. */
export function claudeLimitStatus(
  claude: ClientKeyClaudeUsage | null,
  nowMs: number
): ClaudeLimitStatus | null {
  if (!claude || claude.limitProUnits === null || claude.limitProUnits <= 0) return null;
  const limit = claude.limitProUnits;
  const used = claude.currentProUnits;
  // The key's own window end; older backends only report the credential-derived instant.
  const reportedReset = claude.windowResetsAtMs ?? claude.limitResetsAtMs;
  const resetsAtMs = reportedReset !== null && reportedReset > nowMs ? reportedReset : null;
  return {
    limit,
    used,
    remaining: claude.remainingProUnits ?? Math.max(limit - used, 0),
    fraction: Math.min(1, used / limit),
    reached: claude.limitReached,
    resetsAtMs,
  };
}

/** A reached limit is critical even if rounding leaves the fraction under the thresholds. */
export function claudeLimitTone(status: ClaudeLimitStatus): MeterTone {
  return status.reached ? 'critical' : weeklyUtilizationTone(status.fraction);
}

/**
 * Allowance editor text: a limit to set, `null` to clear (blank or 0), or `undefined`
 * when the text is not a non-negative number.
 */
export function parseClaudeLimitInput(text: string, badInput = false): number | null | undefined {
  // A number input reports an empty value for text it could not parse (`badInput`);
  // that must not pass as a request to clear the limit.
  if (badInput) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return normalizeClientUsageLimit(value);
}

/** Editor text for a configured allowance (`1.5`, `0.25`); blank without a limit. */
export function formatClaudeLimitInput(limit: number | null): string {
  const normalized = normalizeClientUsageLimit(limit);
  return normalized === null ? '' : String(normalized);
}

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
  /** Null without a configured Claude allowance. */
  claudeLimit: ClaudeLimitStatus | null;
  /** The key's open 7-day window; null when none is open. */
  claudeWindow: ClaudeWindowStatus | null;
  claudeCredentials: ClientKeyClaudeCredentialUsage[];
  topModels: ClientUsageModel[];
}

export interface ClientUsageRowOptions {
  localNames: ReadonlyMap<string, string>;
  anonymousLabel: string;
  today: string;
  /** Decides whether an allowance's reset instant is still ahead. */
  nowMs: number;
}

/**
 * One row per key, heaviest Claude users first, then by 7-day tokens and name.
 * Configured keys that were never used go last, as do keys that only have a limit.
 */
export function buildClientUsageRows(
  keys: readonly ClientKeyUsage[],
  { localNames, anonymousLabel, today, nowMs }: ClientUsageRowOptions
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
      claudeCurrentProUnits: claudeUsed(entry.claude) ? entry.claude.currentProUnits : null,
      claudeTotalProUnits: entry.claude?.totalProUnits ?? 0,
      claudeShare: null,
      claudeLimit: claudeLimitStatus(entry.claude, nowMs),
      claudeWindow: claudeWindowStatus(entry.claude, nowMs),
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
