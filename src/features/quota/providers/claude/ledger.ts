import type { TFunction } from 'i18next';
import type { ClaudeQuotaState } from '@/types';
import { orderLedgerWindows, remainingFromUsed, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot, LedgerWindow } from '../../ledgerModel';

/**
 * Account-wide windows lead: they gate every request, so the 7-day limit is the
 * one the summary pools (in Pro weeks, beside the 5-hour limit in Pro sessions).
 * Model-scoped limits (Fable) follow in payload order and get their own lane in
 * the ledger (laneModel.ts) — their own bar is not always what stops the model,
 * so they are no longer the headline.
 */
const CLAUDE_HEADLINE_ORDER = ['seven-day', 'five-hour'] as const;

export const CLAUDE_SESSION_WINDOW_ID = 'five-hour';
const CLAUDE_WEEKLY_WINDOW_ID = 'seven-day';
/** The Fable limit's id, from either payload shape (see data.ts). */
const CLAUDE_FABLE_WINDOW_ID = 'seven-day-fable';

/**
 * Each plan's 5-hour (session) limit in Pro sessions, keyed by the plan type
 * resolveClaudePlanType gives, so the summary pools sessions of different sizes.
 * Keep in step with SessionProUnits in the backend's internal/claudeplan.
 */
export const CLAUDE_SESSION_PRO_UNITS: ReadonlyMap<string, number> = new Map([
  ['plan_pro', 1],
  ['plan_team', 1.25],
  ['plan_max5', 5],
  ['plan_max20', 20],
]);

/**
 * Each plan's weekly allowance in Pro weeks, which weighs the account-wide 7-day
 * limit and the Fable limit as the proxy's weekly and Fable figures do (assuming,
 * as the proxy does, that a plan's Fable allowance scales like its week). These
 * are not the session ratios: a Max 20x week is about ten Pro weeks, though its
 * session is twenty. Keep in step with ProUnits in the backend's
 * internal/claudeplan. Other model limits (Opus, Sonnet) pool unweighted.
 */
export const CLAUDE_WEEKLY_PRO_UNITS: ReadonlyMap<string, number> = new Map([
  ['plan_pro', 1],
  ['plan_team', 1.25],
  ['plan_max5', 5],
  ['plan_max20', 10],
]);

/** The table a pooled window is weighed by; other windows pool unweighted. */
const CLAUDE_PRO_UNITS_BY_WINDOW: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  [CLAUDE_SESSION_WINDOW_ID, CLAUDE_SESSION_PRO_UNITS],
  [CLAUDE_WEEKLY_WINDOW_ID, CLAUDE_WEEKLY_PRO_UNITS],
  [CLAUDE_FABLE_WINDOW_ID, CLAUDE_WEEKLY_PRO_UNITS],
]);

/**
 * A plan the table does not size — the profile request failed, Max of unknown
 * size, Free — counts as one Pro, and says so.
 */
const planWeight = (
  table: ReadonlyMap<string, number>,
  planType: string | null | undefined
): Pick<LedgerWindow, 'weight' | 'weightAssumed'> => {
  const units = planType ? table.get(planType) : undefined;
  return units !== undefined ? { weight: units } : { weight: 1, weightAssumed: true };
};

/**
 * A weighted window's scale as shown beside its pool: `Pro 100% · Team 125% · …`,
 * per session for the 5-hour pool and per week for the weekly ones.
 */
export const formatClaudeProUnitsScale = (t: TFunction, windowId: string): string =>
  [...(windowId === CLAUDE_SESSION_WINDOW_ID ? CLAUDE_SESSION_PRO_UNITS : CLAUDE_WEEKLY_PRO_UNITS)]
    .map(([planType, units]) => `${t(`claude_quota.${planType}`)} ${units * 100}%`)
    .join(' · ');

export function buildClaudeLedger(quota: ClaudeQuotaState, t: TFunction): LedgerSnapshot {
  return {
    plan: quota.planType ? t(`claude_quota.${quota.planType}`) : null,
    windows: orderLedgerWindows(quota.windows ?? [], CLAUDE_HEADLINE_ORDER).map((window) => {
      const units = CLAUDE_PRO_UNITS_BY_WINDOW.get(window.id);
      return {
        id: window.id,
        label: window.labelKey ? t(window.labelKey, window.labelParams) : window.label,
        remaining: remainingFromUsed(window.usedPercent),
        resetAtMs: usableMs(window.resetAtMs),
        resetLabel: window.resetLabel,
        periodHours: window.periodHours ?? null,
        ...(window.scope ? { scope: window.scope } : {}),
        ...(window.model ? { model: window.model } : {}),
        ...(units ? planWeight(units, quota.planType) : {}),
      };
    }),
  };
}
