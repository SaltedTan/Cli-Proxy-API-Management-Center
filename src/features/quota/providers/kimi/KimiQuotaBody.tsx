/**
 * Kimi 额度渲染体：用量行水位条。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { KimiQuotaState } from '@/types';
import { buildResetDisplay, formatKimiResetHint } from '@/utils/quota';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { clampPercent, formatPercent } from '../../ledgerModel';
import { PacedMeter, QuotaRowPace } from '../../components/QuotaPace';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps } from '../../types';

export function KimiQuotaBody({ quota, classes }: QuotaBodyProps<KimiQuotaState>) {
  const { t, i18n } = useTranslation();
  // Ahead of the early return below — hooks cannot be conditional.
  const now = useNow();
  const soonestRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants('kimi', quota), now),
    [quota, now]
  );
  const rows = quota.rows ?? [];

  if (rows.length === 0) {
    return <div className={classes.quotaMessage}>{t('kimi_quota.empty_data')}</div>;
  }

  return (
    <>
      {rows.map((row, index) => {
        const limit = row.limit;
        const used = row.used;
        const remaining =
          limit > 0 ? clampPercent(((limit - used) / limit) * 100) : used > 0 ? 0 : null;
        const percentLabel = formatPercent(remaining);
        const rowLabel = row.labelKey
          ? t(row.labelKey, (row.labelParams ?? {}) as Record<string, string | number>)
          : (row.label ?? '');
        const resetDisplay = buildResetDisplay(
          row.resetAtMs == null ? formatKimiResetHint(t, row.resetHint) : null,
          row.resetAtMs,
          now,
          i18n.resolvedLanguage
        );
        const soon = row.id === soonestRowId;

        return (
          <div
            key={row.id}
            className={classes.quotaRow}
            title={soon ? t('quota_management.soonest_row_hint') : undefined}
          >
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{rowLabel}</span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>{percentLabel}</span>
                {resetDisplay && (
                  <QuotaResetLabel display={resetDisplay} classes={classes} soon={soon} />
                )}
              </div>
            </div>
            <PacedMeter paceId={row.id}>
              <QuotaMeter percent={remaining} classes={classes} index={index} />
            </PacedMeter>
            <QuotaRowPace paceId={row.id} />
          </div>
        );
      })}
    </>
  );
}
