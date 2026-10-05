import type { TFunction } from 'i18next';
import type { KimiQuotaState } from '@/types';
import { formatKimiResetHint } from '@/utils/quota';
import { clampPercent, orderLedgerWindows, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot } from '../../ledgerModel';

export function buildKimiLedger(quota: KimiQuotaState, t: TFunction): LedgerSnapshot {
  return {
    plan: null,
    windows: orderLedgerWindows(quota.rows ?? [], ['summary']).map((row) => {
      const resetAtMs = usableMs(row.resetAtMs);
      return {
        id: row.id,
        label: row.labelKey
          ? t(row.labelKey, (row.labelParams ?? {}) as Record<string, string | number>)
          : (row.label ?? ''),
        // Kimi reports raw counts; same derivation as KimiQuotaBody.
        remaining:
          row.limit > 0
            ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100))
            : row.used > 0
              ? 0
              : null,
        resetAtMs,
        resetLabel: resetAtMs === null ? formatKimiResetHint(t, row.resetHint) : null,
        periodHours: row.periodHours ?? null,
        periodEstimated: row.periodEstimated,
      };
    }),
  };
}
