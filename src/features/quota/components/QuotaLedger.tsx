/**
 * Ledger view: credentials as rows, grouped by provider, quota windows as
 * columns.
 *
 * Built for comparison — the same window sits in the same column on every row
 * of a group, so scanning down a column answers "which account still has
 * weekly headroom" without reading cards. Provider-specific detail (reset
 * credits, billing, reset actions) lives behind the row's disclosure, which
 * renders the same content as a card.
 *
 * Loading stays click-to-fetch, exactly as on the cards.
 */

import { useId, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconRefreshCw } from '@/components/ui/icons';
import { buildResetDisplay, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { HOUR_MS } from '@/utils/time/durations';
import { getTypeLabel } from '@/features/authFiles/constants';
import { LEDGER_MAX_COLUMNS } from '../constants';
import { buildLedgerColumns, type LedgerColumn, type LedgerSnapshot } from '../ledgerModel';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { maskEmailsInText } from '../maskEmail';
import { computeWindowPace } from '../paceModel';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { bindPaceClasses, bindQuotaClasses } from '../types';
import { QuotaCardContent } from './QuotaCard';
import { QuotaMeter } from './QuotaMeter';
import { PaceMark, PaceVerdict } from './QuotaPace';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaLedger.module.scss';
import paceModule from './QuotaPace.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');
const paceStyles = bindPaceClasses(paceModule, 'QuotaPace.module.scss');

export interface QuotaLedgerProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  /** Ledger snapshot for loaded credentials; null otherwise. */
  snapshotFor: (entry: QuotaFileEntry) => LedgerSnapshot | null;
  now: number;
  canUseActions: boolean;
  resettingName: string | null;
  maskEmails: boolean;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
}

interface LedgerGroup {
  provider: QuotaProviderType;
  entries: QuotaFileEntry[];
}

/** Group in order of first appearance, so a "soonest recovery" sort still leads. */
const groupByProvider = (entries: QuotaFileEntry[]): LedgerGroup[] => {
  const groups = new Map<QuotaProviderType, QuotaFileEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.type);
    if (list) list.push(entry);
    else groups.set(entry.type, [entry]);
  }
  return [...groups].map(([provider, list]) => ({ provider, entries: list }));
};

export function QuotaLedger(props: QuotaLedgerProps) {
  const groups = useMemo(() => groupByProvider(props.entries), [props.entries]);
  return (
    <div className={styles.ledger}>
      {groups.map((group) => (
        <LedgerGroupSection key={group.provider} group={group} {...props} />
      ))}
    </div>
  );
}

function LedgerGroupSection({
  group,
  snapshotFor,
  ...rowProps
}: QuotaLedgerProps & { group: LedgerGroup }) {
  const { t } = useTranslation();
  const headingId = useId();
  const columns = useMemo(
    () => buildLedgerColumns(group.entries.map(snapshotFor)).slice(0, LEDGER_MAX_COLUMNS),
    [group.entries, snapshotFor]
  );
  const style = { '--ledger-cols': Math.max(columns.length, 1) } as CSSProperties;

  return (
    <section className={styles.group} aria-labelledby={headingId} style={style}>
      <h2 id={headingId} className={styles.groupTitle}>
        {getTypeLabel(t, group.provider)}
        <span className={styles.groupCount}>{group.entries.length}</span>
      </h2>
      <ul className={styles.rows}>
        {group.entries.map((entry) => (
          <LedgerRow
            key={getQuotaCacheKey(entry.file)}
            entry={entry}
            columns={columns}
            snapshot={snapshotFor(entry)}
            {...rowProps}
          />
        ))}
      </ul>
    </section>
  );
}

type LedgerRowProps = Omit<QuotaLedgerProps, 'entries' | 'snapshotFor'> & {
  entry: QuotaFileEntry;
  columns: LedgerColumn[];
  snapshot: LedgerSnapshot | null;
};

function LedgerRow({
  entry,
  columns,
  snapshot,
  quotaFor,
  now,
  canUseActions,
  resettingName,
  maskEmails,
  onRefresh,
  onReset,
}: LedgerRowProps) {
  const { t } = useTranslation();
  const detailId = useId();
  const [expanded, setExpanded] = useState(false);
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const quota = quotaFor(entry);
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const canRefresh = canUseActions && !file.disabled;
  const resetting = resettingName === getQuotaCacheKey(file);
  const rawName = getQuotaDisplayName(file);
  const displayName = maskEmails ? maskEmailsInText(rawName, file.email) : rawName;
  const hiddenWindows = snapshot
    ? snapshot.windows.filter((window) => !columns.some((column) => column.id === window.id)).length
    : 0;
  const canExpand = status === 'success' || status === 'error';
  const isExpanded = expanded && canExpand;

  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <span className={styles.name} title={displayName}>
          {displayName}
        </span>
        {snapshot?.plan && <span className={styles.plan}>{snapshot.plan}</span>}
      </div>

      {status === 'idle' ? (
        <button
          type="button"
          className={`${styles.span} ${styles.idle}`}
          onClick={() => onRefresh(entry)}
          disabled={!canRefresh}
        >
          <IconRefreshCw size={14} aria-hidden="true" />
          {t(`${adapter.i18nPrefix}.idle`)}
        </button>
      ) : loading ? (
        <div className={`${styles.span} ${styles.loading}`} aria-busy="true">
          <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
          {Array.from({ length: Math.max(columns.length, 1) }, (_, index) => (
            <span key={index} className={styles.skeletonCell} aria-hidden="true">
              <span className={styles.skeletonLabel} />
              <span className={styles.skeletonTrack} />
            </span>
          ))}
        </div>
      ) : status === 'error' ? (
        <div className={`${styles.span} ${styles.error}`} role="alert">
          {t(`${adapter.i18nPrefix}.load_failed`, {
            message: resolveQuotaErrorMessage(
              t,
              quota?.errorStatus,
              quota?.error || t('common.unknown_error')
            ),
          })}
        </div>
      ) : snapshot && snapshot.windows.length > 0 ? (
        columns.map((column, index) => (
          <WindowCell
            key={column.id}
            window={snapshot.windows.find((window) => window.id === column.id) ?? null}
            index={index}
            now={now}
          />
        ))
      ) : (
        <div className={`${styles.span} ${styles.message}`}>
          {t('quota_management.ledger_no_windows')}
        </div>
      )}

      <div className={styles.actions}>
        {hiddenWindows > 0 && (
          <span className={styles.more}>
            {t('quota_management.ledger_more_windows', { count: hiddenWindows })}
          </span>
        )}
        {canExpand && (
          <button
            type="button"
            className={styles.iconAction}
            aria-expanded={isExpanded}
            aria-controls={detailId}
            aria-label={t(
              isExpanded
                ? 'quota_management.ledger_hide_details'
                : 'quota_management.ledger_show_details'
            )}
            title={t(
              isExpanded
                ? 'quota_management.ledger_hide_details'
                : 'quota_management.ledger_show_details'
            )}
            onClick={() => setExpanded((value) => !value)}
          >
            <IconChevronDown
              size={15}
              className={isExpanded ? styles.chevronOpen : styles.chevron}
              aria-hidden="true"
            />
          </button>
        )}
        <button
          type="button"
          className={styles.refresh}
          onClick={() => onRefresh(entry)}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw
            size={13}
            className={loading ? styles.spinning : undefined}
            aria-hidden="true"
          />
          {t('auth_files.quota_refresh_single')}
        </button>
      </div>

      {canExpand && (
        <div id={detailId} className={styles.detail} hidden={!isExpanded}>
          {isExpanded && (
            <QuotaCardContent
              entry={entry}
              quota={quota}
              snapshot={snapshot}
              canRefresh={canRefresh}
              resetting={resetting}
              onRefresh={() => onRefresh(entry)}
              onReset={() => onReset(entry)}
              showRefresh={false}
            />
          )}
        </div>
      )}
    </li>
  );
}

function WindowCell({
  window,
  index,
  now,
}: {
  window: LedgerSnapshot['windows'][number] | null;
  index: number;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  // A column this credential does not report: keep the slot so columns align.
  if (!window) return <div className={styles.cell} aria-hidden="true" />;

  const reset = buildResetDisplay(window.resetLabel, window.resetAtMs, now, i18n.resolvedLanguage);
  const urgent =
    window.resetAtMs !== null && window.resetAtMs > now && window.resetAtMs - now < HOUR_MS;
  const pace = computeWindowPace(window, now);
  const knownPace = pace.status === 'unknown' ? null : pace;

  return (
    <div className={styles.cell}>
      <div className={styles.cellHead}>
        <span className={styles.cellLabel} title={window.label}>
          {window.label}
        </span>
        <span className={styles.cellPercent}>
          {window.remaining === null ? '--' : `${Math.round(window.remaining)}%`}
        </span>
      </div>
      <div className={paceStyles.meter}>
        <QuotaMeter percent={window.remaining} classes={quotaClasses} index={index} />
        {knownPace && <PaceMark pace={knownPace} classes={paceStyles} />}
      </div>
      <div className={styles.cellReset}>
        {reset === null ? (
          <span className={styles.resetAbsolute}>{t('quota_management.no_reset_pending')}</span>
        ) : (
          <>
            {reset.relative && (
              <span className={urgent ? styles.resetUrgent : styles.resetRelative}>
                {reset.relative}
              </span>
            )}
            <span className={reset.relative ? styles.resetAbsoluteAfter : styles.resetAbsolute}>
              {reset.absolute}
            </span>
          </>
        )}
      </div>
      {knownPace && window.remaining !== null && (
        <PaceVerdict
          pace={knownPace}
          remaining={window.remaining}
          now={now}
          classes={paceStyles}
          className={styles.cellPace}
        />
      )}
    </div>
  );
}
