import type { TFunction } from 'i18next';
import type { MetaQuotaState } from '@/types';
import { orderLedgerWindows, remainingFromUsed } from '../../ledgerModel';
import type { LedgerSnapshot } from '../../ledgerModel';

export function buildMetaLedger(quota: MetaQuotaState, t: TFunction): LedgerSnapshot {
  const data = quota.data;
  if (!data) return { plan: null, windows: [] };
  return {
    plan: data.planName ?? null,
    windows: orderLedgerWindows(data.windows, ['weekly', 'window']).map((window) => ({
      id: window.id,
      label:
        window.id === 'window' && window.durationMinutes
          ? t('meta_quota.window_duration', { minutes: window.durationMinutes })
          : t(`meta_quota.${window.id}`),
      remaining: remainingFromUsed(window.usedPercent),
      // Unix seconds upstream.
      resetAtMs: typeof window.resetAt === 'number' ? window.resetAt * 1000 : null,
      resetLabel: null,
      // The upstream weekly bucket has no duration field; its scope defines seven days.
      periodHours:
        window.id === 'weekly'
          ? 24 * 7
          : window.durationMinutes
            ? window.durationMinutes / 60
            : null,
    })),
  };
}
