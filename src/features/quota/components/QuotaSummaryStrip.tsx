/**
 * Provider rollup strip: one cell per provider in the current tab.
 *
 * Each cell pools the provider's headline window across its credentials
 * ("409% of 500%"), draws one segment per credential so a single exhausted
 * account stays visible inside a healthy total, names the soonest reset and
 * tallies how many credentials spend that window over, on or under pace.
 * Secondary windows fold behind a toggle — the strip is for orientation, the
 * ledger below is for detail.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { ProviderSummary, ProviderSummaryLine } from '../ledgerModel';
import type { PaceCounts } from '../paceModel';
import type { QuotaProviderType } from '../providers/types';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import styles from './QuotaSummaryStrip.module.scss';

export interface QuotaSummaryGroup {
  provider: QuotaProviderType;
  summary: ProviderSummary;
}

export interface QuotaSummaryStripProps {
  groups: QuotaSummaryGroup[];
  resolvedTheme: ResolvedTheme;
  now: number;
}

const levelClass = (remaining: number) =>
  remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
    ? styles.segmentHigh
    : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
      ? styles.segmentMedium
      : styles.segmentLow;

export function QuotaSummaryStrip({ groups, resolvedTheme, now }: QuotaSummaryStripProps) {
  const { t } = useTranslation();
  if (groups.length === 0) return null;

  return (
    <section className={styles.strip} aria-label={t('quota_management.summary_label')}>
      {groups.map((group) => (
        <SummaryCell key={group.provider} group={group} resolvedTheme={resolvedTheme} now={now} />
      ))}
    </section>
  );
}

function SummaryCell({
  group,
  resolvedTheme,
  now,
}: {
  group: QuotaSummaryGroup;
  resolvedTheme: ResolvedTheme;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { provider, summary } = group;
  const typeLabel = getTypeLabel(t, provider);
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const headline = summary.headline;
  const capacity = headline?.capacity ?? summary.credentialCount * 100;
  const total = headline?.totalRemaining ?? null;
  const segments =
    headline?.segments ?? Array.from({ length: summary.credentialCount }, () => null);
  const [firstSecondary, ...moreSecondary] = summary.secondary;
  const listId = `quota-summary-${provider}-more`;

  return (
    <article className={styles.cell}>
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          style={
            isThemeSurfaceIconProvider(provider)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className={styles.provider}>{typeLabel}</span>
        <span className={styles.count}>
          {t('quota_management.summary_credentials', { count: summary.credentialCount })}
        </span>
      </header>

      <div className={styles.headlineLabel}>
        {headline?.label ?? t('quota_management.summary_not_loaded')}
      </div>
      <div className={styles.figure}>
        <span className={styles.total}>{total === null ? '--' : `${total}%`}</span>
        <span className={styles.capacity}>
          {t('quota_management.summary_of_capacity', { capacity })}
        </span>
      </div>

      <div
        className={styles.segments}
        role="img"
        aria-label={t('quota_management.summary_segments_label', {
          total: total === null ? '--' : `${total}%`,
          capacity: `${capacity}%`,
          count: segments.length,
        })}
      >
        {segments.map((remaining, index) => (
          <span key={index} className={styles.segment}>
            {remaining !== null && (
              <span
                className={`${styles.segmentFill} ${levelClass(remaining)}`}
                style={{ width: `${remaining}%` }}
              />
            )}
          </span>
        ))}
      </div>

      {headline?.nextResetMs != null && (
        <ResetLine atMs={headline.nextResetMs} now={now} locale={i18n.resolvedLanguage} />
      )}

      {headline && <PaceLine pace={headline.pace} />}

      {firstSecondary && (
        <div className={styles.secondary}>
          <div className={styles.secondaryRow}>
            <SecondaryLine line={firstSecondary} />
            {moreSecondary.length > 0 && (
              <button
                type="button"
                className={styles.toggle}
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded
                  ? t('quota_management.summary_hide_more')
                  : t('quota_management.summary_show_more')}
              </button>
            )}
          </div>
          {moreSecondary.length > 0 && (
            <div id={listId} hidden={!expanded} className={styles.secondaryMore}>
              {moreSecondary.map((line) => (
                <div key={line.id} className={styles.secondaryRow}>
                  <SecondaryLine line={line} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function SecondaryLine({ line }: { line: ProviderSummaryLine }) {
  return (
    <span className={styles.secondaryLine}>
      <span className={styles.secondaryLabel}>{line.label}</span>
      <span className={styles.secondaryValue}>
        {line.totalRemaining === null ? '--' : `${line.totalRemaining}%`}
      </span>
    </span>
  );
}

function ResetLine({ atMs, now, locale }: { atMs: number; now: number; locale?: string }) {
  return (
    <div className={styles.reset}>
      <span className={styles.resetRelative}>{formatRelativeInstant(atMs, now, locale)}</span>
      <span className={styles.resetAbsolute}>{formatInstantShort(atMs)}</span>
    </div>
  );
}

const PACE_ORDER: readonly (keyof PaceCounts)[] = ['over', 'on', 'under'];

/** Per-credential pace tally for the headline window; nothing when no pace is known. */
function PaceLine({ pace }: { pace: PaceCounts }) {
  const { t } = useTranslation();
  const parts = PACE_ORDER.filter((status) => pace[status] > 0);
  if (parts.length === 0) return null;
  return (
    <div className={styles.pace}>
      <span className={styles.paceLabel}>{t('quota_management.pace_summary_label')}</span>
      {parts.map((status) => (
        <span key={status} className={status === 'over' ? styles.paceOver : styles.paceCount}>
          {t(`quota_management.pace_count_${status}`, { count: pace[status] })}
        </span>
      ))}
    </div>
  );
}
