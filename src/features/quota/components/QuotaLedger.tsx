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
 *
 * A group whose credentials carry a model-scoped limit (Claude's Fable weekly)
 * swaps window columns for lanes — one per model, plus one for every other
 * model — that say whether the credential can serve the model now and which
 * window decides it (laneModel.ts). Every raw window stays on the row as a chip.
 *
 * A credential the proxy will not select says so beside its name, apart from
 * its quota: the cached windows stay on the row, but its lanes are unavailable.
 */

import { useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconRefreshCw } from '@/components/ui/icons';
import {
  buildResetDisplay,
  formatInstantWeekday,
  formatRelativeInstant,
  resolveQuotaErrorMessage,
} from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { HOUR_MS } from '@/utils/time/durations';
import { getTypeLabel } from '@/features/authFiles/constants';
import { LEDGER_MAX_COLUMNS } from '../constants';
import {
  approximateInstant,
  buildLaneColumns,
  buildQuotaLanes,
  credentialBlockFromAuthFile,
  hasModelLanes,
  ledgerPausesFromCooldowns,
  type LaneColumn,
  type QuotaLane,
} from '../laneModel';
import {
  buildLedgerColumns,
  type LedgerColumn,
  type LedgerSnapshot,
  type LedgerWindow,
} from '../ledgerModel';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { maskEmailsInText } from '../maskEmail';
import { computeWindowPace } from '../paceModel';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { bindPaceClasses, bindQuotaClasses } from '../types';
import { QuotaCardContent } from './QuotaCard';
import {
  QUOTA_PROGRESS_HIGH_THRESHOLD,
  QUOTA_PROGRESS_MEDIUM_THRESHOLD,
  QuotaMeter,
} from './QuotaMeter';
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
  const snapshots = useMemo(() => group.entries.map(snapshotFor), [group.entries, snapshotFor]);
  const laneColumns = useMemo(
    () => (snapshots.some(hasModelLanes) ? buildLaneColumns(snapshots) : null),
    [snapshots]
  );
  const columns = useMemo(
    () => buildLedgerColumns(snapshots).slice(0, LEDGER_MAX_COLUMNS),
    [snapshots]
  );
  const columnCount = laneColumns ? laneColumns.length : columns.length;
  const style = { '--ledger-cols': Math.max(columnCount, 1) } as CSSProperties;

  return (
    <section className={styles.group} aria-labelledby={headingId} style={style}>
      <h2 id={headingId} className={styles.groupTitle}>
        {getTypeLabel(t, group.provider)}
        <span className={styles.groupCount}>{group.entries.length}</span>
      </h2>
      <ul className={styles.rows}>
        {laneColumns && <LaneHeadRow columns={laneColumns} />}
        {group.entries.map((entry, index) => (
          <LedgerRow
            key={getQuotaCacheKey(entry.file)}
            entry={entry}
            columns={columns}
            laneColumns={laneColumns}
            snapshot={snapshots[index]}
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
  /** Set when the group renders lanes instead of window columns. */
  laneColumns: LaneColumn[] | null;
  snapshot: LedgerSnapshot | null;
};

const laneTitle = (t: TFunction, model: string | null) =>
  model ?? t('quota_management.lane_other_models');

/**
 * Column titles for a lane group, once above the rows. Hidden from assistive
 * tech: each lane carries its own title (visually hidden on wide layouts). The
 * trailing copy of the row actions keeps the lane columns aligned with the
 * rows, which are separate grids.
 */
function LaneHeadRow({ columns }: { columns: LaneColumn[] }) {
  const { t } = useTranslation();
  return (
    <li className={`${styles.row} ${styles.laneHead}`} aria-hidden="true">
      <span />
      {columns.map((column) => (
        <span key={column.id} className={styles.laneHeadLabel}>
          {laneTitle(t, column.model)}
        </span>
      ))}
      <span className={`${styles.actions} ${styles.laneHeadSpacer}`}>
        <span className={styles.iconAction} />
        <span className={styles.refresh}>
          <IconRefreshCw size={13} />
          {t('auth_files.quota_refresh_single')}
        </span>
      </span>
    </li>
  );
}

function LedgerRow({
  entry,
  columns,
  laneColumns,
  snapshot,
  quotaFor,
  now,
  canUseActions,
  resettingName,
  maskEmails,
  onRefresh,
  onReset,
}: LedgerRowProps) {
  const { t, i18n } = useTranslation();
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
  const lanes = useMemo(
    () => (laneColumns && snapshot ? buildQuotaLanes(snapshot, now) : null),
    [laneColumns, snapshot, now]
  );
  const hiddenWindows =
    snapshot && !lanes
      ? snapshot.windows.filter((window) => !columns.some((column) => column.id === window.id))
          .length
      : 0;
  const canExpand = status === 'success' || status === 'error';
  const isExpanded = expanded && canExpand;
  const pauses = ledgerPausesFromCooldowns(file.cooldownSnapshot);
  const credentialPause = (pauses ?? [])
    .filter((pause) => pause.scope === 'credential' && pause.untilMs > now)
    .reduce<number | null>((latest, pause) => Math.max(latest ?? 0, pause.untilMs), null);
  const block = credentialBlockFromAuthFile(file, pauses);
  const blockText = !block
    ? null
    : block.reason === 'disabled'
      ? t('quota_management.ledger_disabled')
      : block.message
        ? t('quota_management.ledger_unavailable_message', { message: block.message })
        : t('quota_management.ledger_unavailable');

  return (
    <li className={lanes ? `${styles.row} ${styles.laneRow}` : styles.row}>
      <div className={styles.identity}>
        <span className={styles.name} title={displayName}>
          {displayName}
        </span>
        {snapshot?.plan && <span className={styles.plan}>{snapshot.plan}</span>}
        {blockText && (
          <span className={styles.paused} title={blockText}>
            {blockText}
          </span>
        )}
        {credentialPause !== null && (
          <span className={styles.paused}>
            {t('quota_management.ledger_paused_until', {
              at: formatInstantWeekday(credentialPause, i18n.resolvedLanguage),
            })}
          </span>
        )}
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
      ) : lanes && laneColumns && snapshot ? (
        <>
          {laneColumns.map((column) => (
            <LaneCell
              key={column.id}
              lane={lanes.find((lane) => lane.id === column.id) ?? null}
              column={column}
              now={now}
            />
          ))}
          <LimitChips snapshot={snapshot} lanes={lanes} />
        </>
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

function LaneCell({
  lane,
  column,
  now,
}: {
  lane: QuotaLane | null;
  column: LaneColumn;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const title = laneTitle(t, column.model);
  if (!lane) {
    return (
      <div className={styles.laneMissing}>
        <span className={styles.laneTitle}>{title}</span>
        <span>
          {column.model
            ? t('quota_management.lane_no_limit', { model: column.model })
            : t('quota_management.ledger_no_windows')}
        </span>
      </div>
    );
  }

  const { gate, own } = lane;
  const pace = computeWindowPace(gate, now);
  const knownPace = pace.status === 'unknown' ? null : pace;
  const at = (ms: number) => formatInstantWeekday(ms, locale);
  const statusClass = {
    open: styles.statusOpen,
    tight: styles.statusTight,
    partial: styles.statusPartial,
    closed: styles.statusClosed,
    unavailable: styles.statusClosed,
    unknown: styles.statusUnknown,
  }[lane.status];

  let foot: ReactNode = null;
  if (lane.runoutAtMs !== null) {
    foot = (
      <>
        {t('quota_management.lane_runs_out', { at: at(approximateInstant(lane.runoutAtMs)) })}
        {gate.resetAtMs !== null && (
          <span className={styles.laneAside}>
            {t('quota_management.lane_then_refills', { at: at(gate.resetAtMs) })}
          </span>
        )}
      </>
    );
  } else if (lane.status === 'closed') {
    foot =
      lane.reopenAtMs === null ? null : (
        <>
          {t('quota_management.lane_back', {
            relative: formatRelativeInstant(lane.reopenAtMs, now, locale),
          })}
          <span className={styles.laneAside}>{at(lane.reopenAtMs)}</span>
        </>
      );
  } else if (lane.status !== 'unavailable' && own.resetAtMs !== null && own.resetAtMs > now) {
    // "Lasts" is a projection, so it waits until the cycle is far enough along to make one,
    // and an unknown lane makes none.
    const ownPace = computeWindowPace(own, now);
    foot =
      (lane.status === 'open' || lane.status === 'partial') &&
      ownPace.status !== 'unknown' &&
      !ownPace.early ? (
        <>
          {t('quota_management.lane_lasts')}
          <span className={styles.laneAside}>{at(own.resetAtMs)}</span>
        </>
      ) : (
        t('quota_management.lane_refills', { at: at(own.resetAtMs) })
      );
  }

  return (
    <div className={styles.lane}>
      <span className={styles.laneTitle}>{title}</span>
      <div className={styles.laneTop}>
        <span className={`${styles.laneStatus} ${statusClass}`}>
          <span className={styles.statusMark} aria-hidden="true" />
          {t(`quota_management.lane_status_${lane.status}`)}
        </span>
        <span className={styles.lanePercent}>
          {gate.remaining === null ? '--' : `${Math.round(gate.remaining)}%`}
        </span>
      </div>
      <div className={styles.laneGate}>
        <span className={styles.laneGateLabel} title={gate.label}>
          {gate.label}
        </span>
        {lane.runoutAtMs !== null && gate.id !== own.id && (
          <span className={styles.laneCaution}>
            {t('quota_management.lane_runs_out_before', { name: title })}
          </span>
        )}
        {lane.status === 'closed' && gate.remaining !== null && gate.remaining <= 0 && (
          <span className={styles.laneAside}>{t('quota_management.lane_used_up')}</span>
        )}
      </div>
      <div className={paceStyles.meter}>
        <QuotaMeter percent={gate.remaining} classes={quotaClasses} />
        {knownPace && <PaceMark pace={knownPace} classes={paceStyles} />}
      </div>
      {foot && <div className={styles.laneFoot}>{foot}</div>}
      {lane.status === 'unknown' && lane.pausesUnknown && (
        <div className={styles.laneNote}>{t('quota_management.lane_pauses_unknown')}</div>
      )}
      {lane.status === 'unavailable' && (
        <div className={styles.laneNote}>{t('quota_management.lane_unavailable_note')}</div>
      )}
      {lane.modelPauses.length > 0 && (
        <ul className={styles.laneModelPauses}>
          {lane.modelPauses.map((pause) => (
            <li key={pause.modelKey} className={styles.laneNote}>
              {t('quota_management.lane_model_paused', {
                model: pause.modelKey,
                relative: formatRelativeInstant(pause.untilMs, now, locale),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const chipLevelClass = (remaining: number) =>
  remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
    ? styles.chipHigh
    : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
      ? styles.chipMedium
      : styles.chipLow;

/**
 * Every window of a lane row, account-wide shortest first, then the scoped
 * ones. The windows currently deciding a lane are outlined.
 */
function LimitChips({ snapshot, lanes }: { snapshot: LedgerSnapshot; lanes: QuotaLane[] }) {
  const { t, i18n } = useTranslation();
  const labelId = useId();
  const deciding = new Set(
    lanes
      .filter((lane) => lane.status === 'closed' || lane.runoutAtMs !== null)
      .map((lane) => lane.gate.id)
  );
  const account = snapshot.windows
    .filter((window) => window.scope === 'account')
    .sort((a, b) => (a.periodHours ?? 0) - (b.periodHours ?? 0));
  const ordered: LedgerWindow[] = [
    ...account,
    ...snapshot.windows.filter((window) => window.scope !== 'account'),
  ];

  return (
    <div className={styles.chips}>
      <span id={labelId} className={styles.chipsLabel}>
        {t('quota_management.ledger_limits_label')}
      </span>
      <ul className={styles.chipList} aria-labelledby={labelId}>
        {ordered.map((window) => (
          <li
            key={window.id}
            className={
              deciding.has(window.id) ? `${styles.chip} ${styles.chipDeciding}` : styles.chip
            }
          >
            <span className={styles.chipLabel}>{window.label}</span>
            <span className={styles.chipBar} aria-hidden="true">
              {window.remaining !== null && (
                <span
                  className={`${styles.chipFill} ${chipLevelClass(window.remaining)}`}
                  style={{ width: `${window.remaining}%` }}
                />
              )}
            </span>
            <span className={styles.chipPercent}>
              {window.remaining === null ? '--' : `${Math.round(window.remaining)}%`}
            </span>
            <span className={styles.chipReset}>
              {window.resetAtMs === null
                ? t('quota_management.no_reset_pending')
                : formatInstantWeekday(window.resetAtMs, i18n.resolvedLanguage)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
