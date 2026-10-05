import type { TFunction } from 'i18next';
import type { AntigravityQuotaState } from '@/types';
import { clampPercent, usableMs } from '../../ledgerModel';
import type { LedgerSnapshot } from '../../ledgerModel';
import {
  ANTIGRAVITY_BUCKET_LABEL_KEYS,
  ANTIGRAVITY_GROUP_LABEL_KEYS,
  getAntigravityPlanLabel,
  translateAntigravityQuotaLabel,
} from './labels';

/** Ledger window id of a bucket; the card body looks its pace up by the same id. */
export const antigravityWindowId = (groupId: string, bucketId: string) => `${groupId}:${bucketId}`;

/**
 * Buckets flattened across groups in the payload's order. With more than one
 * group, the group name prefixes each label — two "Weekly limit" columns would
 * otherwise be indistinguishable.
 */
export function buildAntigravityLedger(quota: AntigravityQuotaState, t: TFunction): LedgerSnapshot {
  const groups = quota.groups ?? [];
  const prefixed = groups.length > 1;
  return {
    plan: getAntigravityPlanLabel(quota.subscription, t),
    windows: groups.flatMap((group) => {
      const groupLabel = translateAntigravityQuotaLabel(
        group.label,
        ANTIGRAVITY_GROUP_LABEL_KEYS,
        t
      );
      return group.buckets.map((bucket) => {
        const bucketLabel = translateAntigravityQuotaLabel(
          bucket.label,
          ANTIGRAVITY_BUCKET_LABEL_KEYS,
          t
        );
        return {
          id: antigravityWindowId(group.id, bucket.id),
          label: prefixed ? `${groupLabel} · ${bucketLabel}` : bucketLabel,
          // Antigravity reports the fraction REMAINING.
          remaining: clampPercent(Math.round(bucket.remainingFraction * 100)),
          resetAtMs: usableMs(bucket.resetAtMs),
          resetLabel: null,
          periodHours: bucket.periodHours ?? null,
        };
      });
    }),
  };
}
