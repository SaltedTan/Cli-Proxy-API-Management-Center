import type { TFunction } from 'i18next';
import type { ClaudeQuotaState } from '@/types';
import { orderLedgerWindows, remainingFromUsed, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot } from '../../ledgerModel';

/**
 * Account-wide windows lead: they gate every request, so the 7-day limit is the
 * one the summary pools. Model-scoped limits (Fable) follow in payload order and
 * get their own lane in the ledger (laneModel.ts) — their own bar is not always
 * what stops the model, so they are no longer the headline.
 */
const CLAUDE_HEADLINE_ORDER = ['seven-day', 'five-hour'] as const;

export function buildClaudeLedger(quota: ClaudeQuotaState, t: TFunction): LedgerSnapshot {
  return {
    plan: quota.planType ? t(`claude_quota.${quota.planType}`) : null,
    windows: orderLedgerWindows(quota.windows ?? [], CLAUDE_HEADLINE_ORDER).map((window) => ({
      id: window.id,
      label: window.labelKey ? t(window.labelKey, window.labelParams) : window.label,
      remaining: remainingFromUsed(window.usedPercent),
      resetAtMs: usableMs(window.resetAtMs),
      resetLabel: window.resetLabel,
      periodHours: window.periodHours ?? null,
      ...(window.scope ? { scope: window.scope } : {}),
      ...(window.model ? { model: window.model } : {}),
    })),
  };
}
