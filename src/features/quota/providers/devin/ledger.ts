import type { TFunction } from 'i18next';
import type { DevinQuotaState } from '@/types';
import { orderLedgerWindows, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot } from '../../ledgerModel';

export function buildDevinLedger(quota: DevinQuotaState, t: TFunction): LedgerSnapshot {
  return {
    plan: quota.plan,
    windows: orderLedgerWindows(quota.windows ?? [], ['weekly', 'daily']).map((window) => ({
      id: window.id,
      label: t(`devin_quota.${window.id}`),
      // Devin already reports percent remaining.
      remaining: window.remainingPercent,
      resetAtMs: usableMs(window.resetAtMs),
      resetLabel: null,
      periodHours: window.periodHours,
    })),
  };
}
