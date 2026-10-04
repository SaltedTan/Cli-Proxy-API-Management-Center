import type { TFunction } from 'i18next';
import type { XaiQuotaState } from '@/types';
import { parseIsoToMs } from '@/utils/quota';
import { remainingFromUsed, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot, LedgerWindow } from '../../ledgerModel';
import { resolveXaiPlan } from './plan';

/**
 * Weekly limit, then the monthly credit pool, then pay-as-you-go. Mirrors which
 * rows XaiQuotaBody draws as meters; amounts and product usage stay in the body.
 */
export function buildXaiLedger(quota: XaiQuotaState, t: TFunction): LedgerSnapshot {
  const billing = quota.billing;
  if (!billing) return { plan: null, windows: [] };

  if (billing.mode === 'paid-health') {
    return { plan: billing.planLabel ?? t('xai_quota.plan_paid'), windows: [] };
  }

  const inferredPlan = resolveXaiPlan(billing.monthlyLimitCents);
  const plan = billing.planLabel ?? (inferredPlan ? t(`xai_quota.${inferredPlan.labelKey}`) : null);
  const windows: LedgerWindow[] = [];

  const weeklyRemaining =
    billing.periodType === 'weekly' ? remainingFromUsed(billing.usagePercent) : null;
  const hasWeeklyData =
    billing.periodType === 'weekly' &&
    (weeklyRemaining !== null || Boolean(billing.periodEnd) || billing.productUsage.length > 0);
  if (hasWeeklyData) {
    windows.push({
      id: 'weekly',
      label: t('xai_quota.weekly_limit'),
      remaining: weeklyRemaining,
      resetAtMs: usableMs(billing.resetAtMs),
      resetLabel: null,
      periodHours: billing.periodHours ?? 24 * 7,
    });
  }

  const hasMonthlyData =
    (billing.monthlyLimitCents !== null ||
      billing.usedCents !== null ||
      Boolean(billing.billingPeriodEnd)) &&
    !(hasWeeklyData && billing.monthlyLimitCents === 0 && billing.usedCents === 0);
  if (hasMonthlyData) {
    windows.push({
      id: 'monthly',
      label: t('xai_quota.monthly_credits'),
      remaining: remainingFromUsed(billing.usedPercent),
      resetAtMs: parseIsoToMs(billing.billingPeriodEnd),
      resetLabel: null,
      periodHours: 24 * 30,
    });
  }

  if ((billing.onDemandCapCents ?? 0) > 0) {
    windows.push({
      id: 'on-demand',
      label: t('xai_quota.pay_as_you_go_label'),
      remaining: remainingFromUsed(billing.onDemandUsedPercent),
      resetAtMs: null,
      resetLabel: null,
      periodHours: null,
    });
  }

  return { plan, windows };
}
