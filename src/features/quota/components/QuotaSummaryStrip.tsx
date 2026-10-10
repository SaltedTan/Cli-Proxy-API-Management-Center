/**
 * Provider rollup strip: one cell per provider in the current tab.
 *
 * Each cell pools the provider's headline window across its credentials
 * ("409% of 500%"), draws one segment per credential so a single exhausted
 * account stays visible inside a healthy total, names the soonest reset and
 * tallies how many credentials spend that window over, on or under pace.
 * A model's own limit (Claude's Fable weekly) gets a block of its own: its pool,
 * how many credentials could serve the model now, and whether any is projected
 * to stop before its refill. A weighted pool (Claude's 5-hour limit, counted in
 * Pro sessions) follows the headline, always in view, with segments as wide as
 * each credential's share; until a Claude credential reports it, a placeholder
 * holds its place. Other secondary windows fold behind a toggle — the
 * strip is for orientation, the ledger below is for detail.
 *
 * Credentials the proxy will not select (disabled, or unavailable for a reason
 * other than a pause) are counted on their own line: their quota stays in the
 * pool as information, but none of it can be spent now.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatInstantWeekday, formatRelativeInstant } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import {
  formatPercent,
  type ProviderModelSummary,
  type ProviderSummary,
  type ProviderSummaryLine,
} from '../ledgerModel';
import { approximateInstant } from '../laneModel';
import type { PaceCounts } from '../paceModel';
import { formatClaudeSessionScale } from '../providers/claude/ledger';
import type { QuotaProviderType } from '../providers/types';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import styles from './QuotaSummaryStrip.module.scss';

export interface QuotaSummaryGroup {
  provider: QuotaProviderType;
  summary: ProviderSummary;
  /** Credentials the proxy will not select, loaded or not. */
  unavailable?: number;
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

/** The segments' accessible name; a weighted pool says which unit it counts in. */
const segmentsLabel = (t: TFunction, line: ProviderSummaryLine | null, count: number) => {
  const total = formatPercent(line?.totalRemaining ?? null);
  const capacity = `${line?.capacity ?? count * 100}%`;
  return line?.weighting
    ? t('quota_management.summary_pro_units_segments_label', { total, capacity, count })
    : t('quota_management.summary_segments_label', { total, capacity, count });
};

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
  const notLoaded = summary.credentialCount - summary.loadedCount;
  // Claude's 5-hour pool keeps its place while credentials load or refresh, so
  // the strip does not jump when the first one reports it.
  const sessionPending =
    provider === 'claude' && summary.weighted.length === 0 && !headline?.weighting && notLoaded > 0;

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
        <span className={styles.total}>{formatPercent(total)}</span>
        <span className={styles.capacity}>
          {t('quota_management.summary_of_capacity', { capacity })}
        </span>
      </div>

      <Segments
        segments={segments}
        weights={headline?.weighting?.weights}
        label={segmentsLabel(t, headline, segments.length)}
      />
      {headline?.weighting && (
        <WeightingNotes assumed={headline.weighting.assumed} notLoaded={notLoaded} />
      )}

      {(group.unavailable ?? 0) > 0 && (
        <div className={styles.unavailable}>
          <span className={`${styles.mark} ${styles.markClosed}`} aria-hidden="true" />
          {t('quota_management.summary_unavailable', { count: group.unavailable })}
        </div>
      )}

      {headline?.nextResetMs != null && (
        <ResetLine atMs={headline.nextResetMs} now={now} locale={i18n.resolvedLanguage} />
      )}

      {headline && <PaceLine pace={headline.pace} />}

      {summary.weighted.map((line) => (
        <WeightedBlock
          key={line.id}
          label={line.label}
          line={line}
          notLoaded={notLoaded}
          now={now}
          locale={i18n.resolvedLanguage}
        />
      ))}
      {sessionPending && (
        <WeightedBlock
          label={t('claude_quota.five_hour')}
          line={null}
          notLoaded={notLoaded}
          now={now}
          locale={i18n.resolvedLanguage}
        />
      )}

      {summary.models.map((model) => (
        <ModelBlock key={model.line.id} model={model} locale={i18n.resolvedLanguage} />
      ))}

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

/** One segment per pooled credential; with weights, each as wide as its share of the pool. */
function Segments({
  segments,
  weights,
  label,
}: {
  segments: (number | null)[];
  weights?: number[];
  label: string;
}) {
  return (
    <div className={styles.segments} role="img" aria-label={label}>
      {segments.map((remaining, index) => (
        <span
          key={index}
          className={styles.segment}
          style={weights ? { flexGrow: weights[index] } : undefined}
        >
          {remaining !== null && (
            <span
              className={`${styles.segmentFill} ${levelClass(remaining)}`}
              style={{ width: `${remaining}%` }}
            />
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * A pool counted in weighted units rather than 100% per credential: Claude's
 * 5-hour limit in Pro sessions, so a Max 20x account holds twenty times what a
 * Pro one does. Always in view — no other line on the strip implies it. With
 * no line yet (nothing that reports it has loaded), it is a placeholder: an
 * unknown figure over an empty track.
 */
function WeightedBlock({
  label,
  line,
  notLoaded,
  now,
  locale,
}: {
  label: string;
  line: ProviderSummaryLine | null;
  notLoaded: number;
  now: number;
  locale?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.model}>
      <div className={styles.headlineLabel}>{label}</div>
      <div className={styles.figure}>
        <span className={styles.modelTotal}>{formatPercent(line?.totalRemaining ?? null)}</span>
        {line && (
          <span className={styles.capacity}>
            {t('quota_management.summary_of_capacity', { capacity: line.capacity })}
          </span>
        )}
      </div>
      {line ? (
        <Segments
          segments={line.segments}
          weights={line.weighting?.weights}
          label={segmentsLabel(t, line, line.segments.length)}
        />
      ) : (
        <div className={styles.segments} aria-hidden="true">
          <span className={styles.segment} />
        </div>
      )}
      {line?.nextResetMs != null && <ResetLine atMs={line.nextResetMs} now={now} locale={locale} />}
      <WeightingNotes assumed={line?.weighting?.assumed ?? 0} notLoaded={notLoaded} />
    </div>
  );
}

/**
 * The unit a weighted pool counts in, how many credentials it had to guess, and
 * how many it leaves out until they load.
 */
function WeightingNotes({ assumed, notLoaded }: { assumed: number; notLoaded: number }) {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.weightScale}>
        {t('quota_management.summary_pro_units_hint', { scale: formatClaudeSessionScale(t) })}
      </div>
      {assumed > 0 && (
        <div className={styles.weightNote}>
          <span className={`${styles.mark} ${styles.markUnknown}`} aria-hidden="true" />
          {t('quota_management.summary_pro_units_assumed', { count: assumed })}
        </div>
      )}
      {notLoaded > 0 && (
        <div className={styles.weightNote}>
          <span className={`${styles.mark} ${styles.markUnknown}`} aria-hidden="true" />
          {t('quota_management.summary_pro_units_not_loaded', { count: notLoaded })}
        </div>
      )}
    </>
  );
}

/**
 * A model's own limit, pooled like the headline, plus what the ledger's lanes
 * say about it: how many credentials could serve the model right now, and how
 * many are projected to stop before their refill (by any window, not just the
 * model's own — see laneModel.ts).
 */
function ModelBlock({ model, locale }: { model: ProviderModelSummary; locale?: string }) {
  const { t } = useTranslation();
  const { line } = model;
  const total = formatPercent(line.totalRemaining);
  const servingClass =
    model.serving === model.carrying
      ? styles.markOpen
      : model.serving > 0 || model.partial > 0
        ? styles.markTight
        : model.unknown > 0
          ? styles.markUnknown
          : styles.markClosed;
  const servingText = [
    t('quota_management.summary_serving', { serving: model.serving, total: model.carrying }),
    ...(model.partial > 0 ? [t('quota_management.summary_partial', { count: model.partial })] : []),
    ...(model.unknown > 0 ? [t('quota_management.summary_unknown', { count: model.unknown })] : []),
  ].join(' · ');

  return (
    <div className={styles.model}>
      <div className={styles.modelHead}>
        <span className={styles.headlineLabel}>{line.label}</span>
        {model.carrying > 0 && (
          <span className={styles.modelServing}>
            <span className={`${styles.mark} ${servingClass}`} aria-hidden="true" />
            {servingText}
          </span>
        )}
      </div>
      <div className={styles.figure}>
        <span className={styles.modelTotal}>{total}</span>
        <span className={styles.capacity}>
          {t('quota_management.summary_of_capacity', { capacity: line.capacity })}
        </span>
      </div>
      <Segments
        segments={line.segments}
        weights={line.weighting?.weights}
        label={segmentsLabel(t, line, line.segments.length)}
      />
      {(model.serving > 0 || model.partial > 0) && (
        <div className={styles.modelOutlook}>
          <span
            className={`${styles.mark} ${model.short > 0 ? styles.markTight : styles.markOpen}`}
            aria-hidden="true"
          />
          {model.short > 0 && model.firstStopMs !== null
            ? t('quota_management.summary_runs_short', {
                short: model.short,
                total: model.carrying,
                at: formatInstantWeekday(approximateInstant(model.firstStopMs), locale),
              })
            : t('quota_management.summary_none_short')}
        </div>
      )}
    </div>
  );
}

function SecondaryLine({ line }: { line: ProviderSummaryLine }) {
  return (
    <span className={styles.secondaryLine}>
      <span className={styles.secondaryLabel}>{line.label}</span>
      <span className={styles.secondaryValue}>{formatPercent(line.totalRemaining)}</span>
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
