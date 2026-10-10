import type { TFunction } from 'i18next';
import type { ClaudeQuotaState } from '@/types';
import { orderLedgerWindows, remainingFromUsed, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot, LedgerWindow } from '../../ledgerModel';

/**
 * Account-wide windows lead: they gate every request, so the 7-day limit is the
 * one the summary pools. Model-scoped limits (Fable) follow in payload order and
 * get their own lane in the ledger (laneModel.ts) — their own bar is not always
 * what stops the model, so they are no longer the headline.
 */
const CLAUDE_HEADLINE_ORDER = ['seven-day', 'five-hour'] as const;

const CLAUDE_SESSION_WINDOW_ID = 'five-hour';

/**
 * Each plan's 5-hour (session) limit in Pro sessions, keyed by the plan type
 * resolveClaudePlanType gives, so the summary pools sessions of different sizes.
 * These are not the weekly ratios (a Max 20x week is about ten Pro weeks), so
 * only the 5-hour window is weighted. Keep in step with SessionProUnits in the
 * backend's internal/claudeplan.
 */
export const CLAUDE_SESSION_PRO_UNITS: ReadonlyMap<string, number> = new Map([
  ['plan_pro', 1],
  ['plan_team', 1.25],
  ['plan_max5', 5],
  ['plan_max20', 20],
]);

/**
 * A plan the table does not size — the profile request failed, Max of unknown
 * size, Free — counts as one Pro session, as the backend does, and says so.
 */
const sessionWeight = (
  planType: string | null | undefined
): Pick<LedgerWindow, 'weight' | 'weightAssumed'> => {
  const units = planType ? CLAUDE_SESSION_PRO_UNITS.get(planType) : undefined;
  return units !== undefined ? { weight: units } : { weight: 1, weightAssumed: true };
};

/** The session scale as shown beside the pool: `Pro 100% · Team 125% · …`. */
export const formatClaudeSessionScale = (t: TFunction): string =>
  [...CLAUDE_SESSION_PRO_UNITS]
    .map(([planType, units]) => `${t(`claude_quota.${planType}`)} ${units * 100}%`)
    .join(' · ');

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
      ...(window.id === CLAUDE_SESSION_WINDOW_ID ? sessionWeight(quota.planType) : {}),
    })),
  };
}
