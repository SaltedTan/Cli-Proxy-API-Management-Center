import type { TFunction } from 'i18next';
import type { ClaudeQuotaState } from '@/types';
import { orderLedgerWindows, remainingFromUsed, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot } from '../../ledgerModel';

/**
 * The model-scoped weekly limit binds first on plans that carry it, so it leads
 * the row; accounts without it lead with the 7-day limit instead. The Fable
 * column only exists when a credential's payload reports that limit, so it
 * appears and disappears with the subscription — no setting involved.
 */
const CLAUDE_HEADLINE_ORDER = ['seven-day-fable', 'seven-day', 'five-hour'] as const;

export function buildClaudeLedger(quota: ClaudeQuotaState, t: TFunction): LedgerSnapshot {
  return {
    plan: quota.planType ? t(`claude_quota.${quota.planType}`) : null,
    windows: orderLedgerWindows(quota.windows ?? [], CLAUDE_HEADLINE_ORDER).map((window) => ({
      id: window.id,
      label: window.labelKey ? t(window.labelKey) : window.label,
      remaining: remainingFromUsed(window.usedPercent),
      resetAtMs: usableMs(window.resetAtMs),
      resetLabel: window.resetLabel,
      periodHours: window.periodHours ?? null,
    })),
  };
}
