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
 *
 * Resets are moved onto the browser clock. The card counts down against the
 * upstream's clock (`serverTimeOffsetMs`, from its Date header); the ledger,
 * summary and pace measure against the browser's, so without the shift a
 * skewed browser clock would have them disagree with the card.
 */
export function buildAntigravityLedger(quota: AntigravityQuotaState, t: TFunction): LedgerSnapshot {
  const groups = quota.groups ?? [];
  const prefixed = groups.length > 1;
  const offsetMs = usableMs(quota.serverTimeOffsetMs) ?? 0;
  return {
    plan: getAntigravityPlanLabel(quota.subscription, t),
    windows: groups.flatMap((group) => {
      const groupLabel = translateAntigravityQuotaLabel(
        group.label,
        ANTIGRAVITY_GROUP_LABEL_KEYS,
        t
      );
      return group.buckets.map((bucket) => {
        const resetAtMs = usableMs(bucket.resetAtMs);
        const bucketLabel = translateAntigravityQuotaLabel(
          bucket.label,
          ANTIGRAVITY_BUCKET_LABEL_KEYS,
          t
        );
        return {
          id: antigravityWindowId(group.id, bucket.id),
          label: prefixed ? `${groupLabel} · ${bucketLabel}` : bucketLabel,
          // Antigravity reports the fraction REMAINING. Unrounded: 0.004 is not used up.
          remaining: clampPercent(bucket.remainingFraction * 100),
          resetAtMs: resetAtMs === null ? null : resetAtMs - offsetMs,
          resetLabel: null,
          periodHours: bucket.periodHours ?? null,
        };
      });
    }),
  };
}
