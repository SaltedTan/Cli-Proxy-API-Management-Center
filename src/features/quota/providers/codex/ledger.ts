import type { TFunction } from 'i18next';
import type { CodexQuotaState } from '@/types';
import { orderLedgerWindows, remainingFromUsed, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot } from '../../ledgerModel';
import { resolveCodexPlanLabel } from './planLabel';

/** Account windows lead; model-scoped and code-review windows follow in payload order. */
const CODEX_HEADLINE_ORDER = ['weekly', 'five-hour', 'monthly'] as const;

export function buildCodexLedger(quota: CodexQuotaState, t: TFunction): LedgerSnapshot {
  return {
    plan: resolveCodexPlanLabel(t, quota.planType),
    windows: orderLedgerWindows(quota.windows ?? [], CODEX_HEADLINE_ORDER).map((window) => ({
      id: window.id,
      label: window.labelKey
        ? t(window.labelKey, window.labelParams as Record<string, string | number>)
        : window.label,
      remaining: remainingFromUsed(window.usedPercent),
      resetAtMs: usableMs(window.resetAtMs),
      resetLabel: window.resetLabel,
      periodHours: window.periodHours ?? null,
    })),
  };
}
