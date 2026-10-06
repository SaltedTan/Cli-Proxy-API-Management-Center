/**
 * Claude 额度数据层：用量窗口 + 套餐 + 额外用量。
 * React-free / SCSS-free —— 由 tests/claudeFableQuota.test.ts 直接消费。
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  ClaudeExtraUsage,
  ClaudeProfileResponse,
  ClaudeQuotaState,
  ClaudeQuotaWindow,
  ClaudeUsageLimit,
  ClaudeUsagePayload,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_USAGE_WINDOW_KEYS,
  claudePeriodHours,
  normalizeNumberValue,
  normalizeStringValue,
  parseClaudeUsagePayload,
  formatQuotaResetTime,
  resolveResetMs,
  createStatusError,
  isClaudeFile,
  isDisabledAuthFile,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaProviderData } from '../types';

export type ClaudeQuotaData = {
  windows: ClaudeQuotaWindow[];
  extraUsage?: ClaudeExtraUsage | null;
  planType?: string | null;
};

/**
 * A model's family is the first word of its display name, so a version bump
 * ("Fable" → "Fable 5" → "Fable 5.1") stays the same limit instead of
 * silently dropping out of the ledger.
 */
const modelFamily = (displayName: string) => displayName.split(/\s+/)[0].toLowerCase();

/** Stable window id per family; Fable keeps the id its legacy payload key used. */
const scopedWindowId = (family: string) =>
  `seven-day-${family.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}`;

interface ScopedModelLimit {
  family: string;
  model: string;
  limit: ClaudeUsageLimit;
}

/**
 * Every model-scoped weekly limit in `limits[]`, one per model family, in
 * payload order. Within a family the active entry wins; entries without a
 * usable percent are skipped so a valid sibling can stand in.
 */
const findScopedModelLimits = (payload: ClaudeUsagePayload): ScopedModelLimit[] => {
  if (!Array.isArray(payload.limits)) return [];

  const families = new Map<string, ClaudeUsageLimit[]>();
  for (const limit of payload.limits) {
    const kind = (normalizeStringValue(limit?.kind) ?? '').trim().toLowerCase();
    const model = (normalizeStringValue(limit?.scope?.model?.display_name) ?? '').trim();
    if (kind !== 'weekly_scoped' || !model || normalizeNumberValue(limit?.percent) === null) {
      continue;
    }
    const family = modelFamily(model);
    families.set(family, [...(families.get(family) ?? []), limit]);
  }

  return [...families].map(([family, candidates]) => {
    const limit = candidates.find((candidate) => candidate.is_active === true) ?? candidates[0];
    const model = (normalizeStringValue(limit.scope?.model?.display_name) ?? '').trim();
    return { family, model, limit };
  });
};

export const buildClaudeQuotaWindows = (
  payload: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaWindow[] => {
  const windows: ClaudeQuotaWindow[] = [];
  const scopedLimits = findScopedModelLimits(payload);
  const scopedFamilies = new Set(scopedLimits.map(({ family }) => family));

  for (const { key, id, labelKey, scope, model } of CLAUDE_USAGE_WINDOW_KEYS) {
    if (model && scopedFamilies.has(modelFamily(model))) continue;
    const window = payload[key as keyof ClaudeUsagePayload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) continue;
    const typedWindow = window as { utilization: number; resets_at: string | null };
    const usedPercent = normalizeNumberValue(typedWindow.utilization);
    const resetLabel = formatQuotaResetTime(typedWindow.resets_at ?? undefined);
    const labelParams = model ? { model } : undefined;
    windows.push({
      id,
      label: t(labelKey, labelParams),
      labelKey,
      ...(labelParams ? { labelParams } : {}),
      scope,
      ...(model ? { model } : {}),
      usedPercent,
      resetLabel,
      // Claude states the period nowhere in the payload, so it comes from the
      // key: `five_hour` is the rolling window, everything else is weekly.
      resetAtMs: resolveResetMs([typedWindow.resets_at]),
      periodHours: claudePeriodHours(key),
    });
  }

  for (const { family, model, limit } of scopedLimits) {
    windows.push({
      id: scopedWindowId(family),
      label: t('claude_quota.seven_day_model', { model }),
      labelKey: 'claude_quota.seven_day_model',
      labelParams: { model },
      scope: 'scoped',
      model,
      usedPercent: normalizeNumberValue(limit.percent),
      resetLabel: formatQuotaResetTime(limit.resets_at ?? undefined),
      // `weekly_scoped` is a 7-day window by definition, so the timeline can
      // place this row alongside the ones derived from the named keys.
      resetAtMs: resolveResetMs([limit.resets_at]),
      periodHours: claudePeriodHours('seven_day'),
    });
  }

  return windows;
};

const normalizeFlagValue = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(trimmed)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(trimmed)) return false;
  }
  return undefined;
};

const parseClaudeProfilePayload = (payload: unknown): ClaudeProfileResponse | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as ClaudeProfileResponse;
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') {
    return payload as ClaudeProfileResponse;
  }
  return null;
};

/**
 * Max comes in two sizes, told apart only by the organization's rate-limit
 * tier (`default_claude_max_5x`, `default_claude_max_20x`). An unrecognised
 * tier keeps the plain "Max" label rather than guessing a size.
 */
const resolveClaudeMaxTier = (rateLimitTier: unknown): string => {
  const tokens = (normalizeStringValue(rateLimitTier) ?? '').toLowerCase().split(/[^a-z0-9]+/);
  if (tokens.includes('20x')) return 'plan_max20';
  if (tokens.includes('5x')) return 'plan_max5';
  return 'plan_max';
};

export const resolveClaudePlanType = (profile: ClaudeProfileResponse | null): string | null => {
  if (!profile) return null;

  const organizationType = normalizeStringValue(
    profile.organization?.organization_type
  )?.toLowerCase();
  const subscriptionStatus = normalizeStringValue(
    profile.organization?.subscription_status
  )?.toLowerCase();

  if (organizationType === 'claude_team' && subscriptionStatus === 'active') {
    return 'plan_team';
  }

  // Account flags include personal subscriptions even for a Team-scoped token.
  const hasClaudeMax = normalizeFlagValue(profile.account?.has_claude_max);
  if (hasClaudeMax) return resolveClaudeMaxTier(profile.organization?.rate_limit_tier);

  const hasClaudePro = normalizeFlagValue(profile.account?.has_claude_pro);
  if (hasClaudePro) return 'plan_pro';

  if (hasClaudeMax === false && hasClaudePro === false) return 'plan_free';

  return null;
};

const fetchClaudeQuota = async (file: AuthFileItem, t: TFunction): Promise<ClaudeQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('claude_quota.missing_auth_index'));
  }

  const [usageResult, profileResult] = await Promise.allSettled([
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_USAGE_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_PROFILE_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
  ]);

  if (usageResult.status === 'rejected') {
    throw usageResult.reason;
  }

  const result = usageResult.value;

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const payload = parseClaudeUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('claude_quota.empty_windows'));
  }

  const windows = buildClaudeQuotaWindows(payload, t);
  const planType =
    profileResult.status === 'fulfilled' &&
    profileResult.value.statusCode >= 200 &&
    profileResult.value.statusCode < 300
      ? resolveClaudePlanType(
          parseClaudeProfilePayload(profileResult.value.body ?? profileResult.value.bodyText)
        )
      : null;

  return { windows, extraUsage: payload.extra_usage, planType };
};

export const CLAUDE_CONFIG: QuotaProviderData<ClaudeQuotaState, ClaudeQuotaData> = {
  type: 'claude',
  i18nPrefix: 'claude_quota',
  filterFn: (file) => isClaudeFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchClaudeQuota,
  storeSelector: (state) => state.claudeQuota,
  storeSetter: 'setClaudeQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: data.windows,
    extraUsage: data.extraUsage,
    planType: data.planType,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
};
