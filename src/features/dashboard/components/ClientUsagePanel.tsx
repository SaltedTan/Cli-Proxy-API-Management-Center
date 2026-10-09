import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { IconChevronDown, IconPencil, IconRefreshCw } from '@/components/ui/icons';
import { useNotificationStore } from '@/stores/useNotificationStore';
import type { Config } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { ClaudeCredentialUsage } from '@/types/clientUsage';
import { formatCompactNumber, formatPercent } from '@/utils/format';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { createSharedClock } from '@/utils/time/sharedClock';
import type { ClientUsageState } from '../hooks/useClientUsage';
import {
  buildClientUsageRows,
  claudeLimitTone,
  claudeCredentialName,
  claudeWindowIdentity,
  claudePlanLabel,
  clientUsageHints,
  clientUsageToday,
  formatClaudeLimitInput,
  formatLimitFraction,
  formatLimitMeterValues,
  formatPlanAllowance,
  formatProUnits,
  initialWindowResetConfirm,
  parseClaudeLimitInput,
  weeklyUtilizationTone,
  windowResetConfirming,
  windowResetConfirmReducer,
  type ClientUsageHint,
  type ClientUsageRow,
} from '../clientUsage';
import { clientKeyMutations, isClientKeyBusy } from '../clientKeyMutations';
import { unrefreshedChangeNotice } from '../polledSnapshot';
import { buildCredentialLabels } from '../routing';
import { Meter } from './Meter';
import { StaleDataNotice } from './StaleDataNotice';
import dash from '../dashboard.module.scss';
import styles from './ClientUsagePanel.module.scss';

const DASH = '—';
const API_KEYS_ROUTE = '/config?field=apiKeys';

// Last-used and reset times only need coarse ticks.
const clock = createSharedClock({ intervalMs: 30_000 });

/**
 * Writes a key's Claude allowance in Pro units per 7-day window; `null` removes it.
 * Resolves false when the change was saved but the panel could not be reloaded.
 */
export type SaveClientLimit = (keyId: string, value: number | null) => Promise<boolean | void>;
/**
 * Ends a key's current 7-day Claude window on the backend; its history is kept. Resolves
 * false when the window was reset but the panel could not be reloaded.
 */
export type ResetClientWindow = (keyId: string) => Promise<boolean | void>;
/**
 * Deletes a key's usage history and, with `clearLimit`, its Claude allowance if one is
 * configured.
 */
export type RemoveClientKey = (keyId: string, clearLimit: boolean) => Promise<void>;
type RemoveRow = (keyId: string) => Promise<void>;

/** The mutation holding the key's lock (save, reset or removal); null when it is free. */
function useClientKeyMutation(keyId: string) {
  const holder = () => clientKeyMutations.holder(keyId);
  return useSyncExternalStore(clientKeyMutations.subscribe, holder, holder);
}

export interface ClientUsagePanelProps {
  usage: ClientUsageState;
  /** Names saved in this browser for configured keys, by key id. */
  localNames: ReadonlyMap<string, string>;
  /**
   * Name Claude credentials as the routing panel does, telling apart credentials that
   * share an email by organization; without them the backend's labels are shown.
   */
  config?: Config | null;
  authFiles?: AuthFileItem[] | null;
  /** Reloads this panel's data without the rest of the dashboard; omitted hides the button. */
  onRefresh?: () => Promise<unknown>;
  /** Omitted (or a backend without `claude_limits_supported`) hides the allowance editor. */
  onSaveLimit?: SaveClientLimit;
  /** Omitted hides the window reset; it is offered only on rows with an open window. */
  onResetWindow?: ResetClientWindow;
  /** Omitted hides the remove control; it is offered only on keys no longer in config. */
  onRemoveKey?: RemoveClientKey;
  /** Injected by tests; the live panel follows the shared clock. */
  nowMs?: number;
}

export function ClientUsagePanel({
  usage,
  localNames,
  config = null,
  authFiles = null,
  onRefresh,
  onSaveLimit,
  onResetWindow,
  onRemoveKey,
  nowMs,
}: ClientUsagePanelProps) {
  const { t, i18n } = useTranslation();
  const tickMs = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const now = nowMs ?? tickMs;
  const locale = i18n.language;
  const [refreshing, setRefreshing] = useState(false);
  const [removals, setRemovals] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);

  // A removed row takes the focus with it. Once the list has re-rendered, keep the focus
  // in it, or on Refresh when no row is left, unless something else has taken it since.
  useEffect(() => {
    if (removals === 0) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (listRef.current ?? refreshRef.current)?.focus();
  }, [removals]);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const data = usage.status === 'ready' ? usage.data : null;
  const sinceMs = data?.sinceMs ?? null;
  const anonymousLabel = t('dashboard.client_usage_anonymous');
  const rows = useMemo(
    () =>
      data
        ? buildClientUsageRows(data.keys, {
            localNames,
            anonymousLabel,
            today: clientUsageToday(data, now),
            nowMs: now,
          })
        : [],
    [data, localNames, anonymousLabel, now]
  );
  const hints = useMemo(() => (data ? clientUsageHints(data.keys) : []), [data]);
  const credentialLabels = useMemo(
    () => buildCredentialLabels(authFiles, config),
    [authFiles, config]
  );
  const anyUsage = rows.some((row) => row.used);
  // Older backends report usage but do not enforce limits; do not offer to edit them.
  const saveLimit = data?.claudeLimitsSupported ? onSaveLimit : undefined;
  // Where allowances exist, a removal clears the key's allowance as configured, not as
  // last reported: a save still in flight may have set one since.
  const clearLimit = data?.claudeLimitsSupported ?? false;
  const removeKey: RemoveRow | undefined =
    onRemoveKey &&
    (async (keyId) => {
      await onRemoveKey(keyId, clearLimit);
      setRemovals((count) => count + 1);
    });

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });

  let notice: { text: string; muted: boolean } | null = null;
  if (usage.status === 'unsupported') {
    notice = { text: t('dashboard.client_usage_unsupported'), muted: true };
  } else if (usage.status === 'error') {
    notice = { text: t('dashboard.client_usage_error'), muted: false };
  }
  const loading = usage.status === 'idle' || usage.status === 'loading';

  return (
    <div className={dash.panel}>
      {(onRefresh || sinceMs !== null) && (
        <div className={styles.toolbar}>
          {sinceMs !== null && (
            <span className={styles.since}>
              {t('dashboard.client_usage_since', { date: formatDate(sinceMs) })}
            </span>
          )}
          {onRefresh && (
            <Button
              ref={refreshRef}
              variant="secondary"
              size="sm"
              className={styles.refresh}
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              aria-busy={refreshing}
              aria-label={t('dashboard.client_usage_refresh_label')}
              title={t('dashboard.client_usage_refresh_hint')}
            >
              <IconRefreshCw
                size={14}
                className={refreshing ? styles.spinning : undefined}
                aria-hidden="true"
              />
              {t('common.refresh')}
            </Button>
          )}
        </div>
      )}

      {loading && (
        <p className={dash.emptyNote} role="status">
          {t('dashboard.client_usage_loading')}
        </p>
      )}

      {notice && (
        <p className={notice.muted ? styles.muted : styles.notice} role="status">
          {notice.text}
        </p>
      )}

      {data && usage.stale && (
        <StaleDataNotice
          t={t}
          locale={locale}
          updatedAtMs={usage.updatedAtMs}
          now={now}
          onRetry={onRefresh ? () => void handleRefresh() : undefined}
          retrying={refreshing}
          retryLabel={t('dashboard.client_usage_refresh_label')}
        />
      )}

      {hints.map((hint) => (
        <HintNotice key={hint.kind} hint={hint} t={t} />
      ))}

      {data && !anyUsage && <p className={dash.emptyNote}>{t('dashboard.client_usage_empty')}</p>}

      {rows.length > 0 && (
        <div className={styles.table}>
          <div className={`${styles.rowMain} ${styles.head}`} aria-hidden="true">
            <span>{t('dashboard.client_usage_col_key')}</span>
            <div className={styles.metrics}>
              <span>{t('dashboard.client_usage_col_claude')}</span>
              <span>{t('dashboard.client_usage_col_tokens')}</span>
              <span>{t('dashboard.client_usage_col_requests')}</span>
              <span>{t('dashboard.client_usage_col_last_used')}</span>
            </div>
          </div>
          <ul
            ref={listRef}
            className={styles.rows}
            aria-label={t('dashboard.client_usage_list_label')}
            tabIndex={-1}
          >
            {rows.map((row) => (
              <UsageRow
                key={row.id}
                row={row}
                t={t}
                locale={locale}
                now={now}
                credentialLabels={credentialLabels}
                onSaveLimit={saveLimit}
                onResetWindow={onResetWindow}
                onRemove={removeKey}
              />
            ))}
          </ul>
        </div>
      )}

      {data && data.claudeCredentials.length > 0 && (
        <div className={styles.credentials}>
          <h3 className={styles.subTitle}>{t('dashboard.client_usage_credentials_title')}</h3>
          <ul className={styles.credentialGrid}>
            {data.claudeCredentials.map((credential) => (
              <CredentialCard
                key={credential.authId}
                credential={credential}
                name={claudeCredentialName(credential, credentialLabels)}
                t={t}
                locale={locale}
                now={now}
              />
            ))}
          </ul>
        </div>
      )}

      <p className={styles.footnote}>{t('dashboard.client_usage_footnote')}</p>
      <Link to={API_KEYS_ROUTE} className={dash.panelLink}>
        {t('dashboard.client_usage_link')}{' '}
        <span className={dash.linkArrow} aria-hidden="true">
          →
        </span>
      </Link>
    </div>
  );
}

function HintNotice({ hint, t }: { hint: ClientUsageHint; t: TFunction }) {
  const text =
    hint.kind === 'no-keys'
      ? t('dashboard.client_usage_hint_no_keys')
      : hint.kind === 'shared-key'
        ? t('dashboard.client_usage_hint_shared_key')
        : t('dashboard.client_usage_hint_removed_keys', { count: hint.count });
  const nudge = hint.kind !== 'removed-keys';
  return (
    <p className={nudge ? styles.notice : styles.muted}>
      {text}
      {nudge && (
        <>
          {' '}
          <Link to={API_KEYS_ROUTE} className={styles.noticeLink}>
            {t('dashboard.client_usage_hint_link')}
          </Link>
        </>
      )}
    </p>
  );
}

function UsageRow({
  row,
  t,
  locale,
  now,
  credentialLabels,
  onSaveLimit,
  onResetWindow,
  onRemove,
}: {
  row: ClientUsageRow;
  t: TFunction;
  locale: string;
  now: number;
  credentialLabels: ReadonlyMap<string, string>;
  onSaveLimit?: SaveClientLimit;
  onResetWindow?: ResetClientWindow;
  onRemove?: RemoveRow;
}) {
  const notInConfig = !row.configured && !row.anonymous;
  const units = (value: number) =>
    t('dashboard.client_usage_pro_units', { value: formatProUnits(value, locale) });
  const share = row.claudeShare === null ? null : formatPercent(row.claudeShare * 100, 0);
  const shareLabel =
    share === null ? null : t('dashboard.client_usage_share_label', { value: share });
  const lastUsed =
    row.lastUsedAtMs === null ? null : formatRelativeInstant(row.lastUsedAtMs, now, locale);
  const claudeCredentials = row.claudeCredentials.filter(
    (credential) => credential.currentProUnits > 0 || credential.totalProUnits > 0
  );
  const hasDetails = claudeCredentials.length > 0 || row.topModels.length > 0;
  // The allowance cell stays visible for unused keys, which otherwise collapse on phones.
  const claudeMetricClass =
    row.claudeLimit || row.claudeWindow || onSaveLimit
      ? `${styles.metric} ${styles.limitMetric}`
      : styles.metric;

  return (
    <li className={row.used ? styles.row : `${styles.row} ${styles.unused}`}>
      <div className={styles.rowMain}>
        <div className={styles.identity}>
          <span className={styles.name} title={row.label.text}>
            {row.label.text}
          </span>
          {(row.secondary || notInConfig) && (
            <span className={styles.identityMeta}>
              {row.secondary && <span className={styles.mono}>{row.secondary}</span>}
              {notInConfig && (
                <span className={styles.badge}>{t('dashboard.client_usage_not_in_config')}</span>
              )}
              {notInConfig && onRemove && <RemoveKeyControl row={row} t={t} onRemove={onRemove} />}
            </span>
          )}
        </div>

        <dl className={styles.metrics}>
          <div className={claudeMetricClass}>
            <dt className={styles.metricLabel}>{t('dashboard.client_usage_col_claude')}</dt>
            <dd className={styles.metricValue}>
              {row.claudeCurrentProUnits === null ? DASH : units(row.claudeCurrentProUnits)}
              {shareLabel !== null && (
                <span className={styles.metricAside} title={shareLabel}>
                  <span aria-hidden="true">{share}</span>
                  <span className={styles.srOnly}>{shareLabel}</span>
                </span>
              )}
            </dd>
            {/* With an allowance, the meter against it replaces the share-of-all-keys bar. */}
            {row.claudeShare !== null && row.claudeLimit === null && (
              <dd className={styles.shareTrack} aria-hidden="true">
                <span
                  className={styles.shareFill}
                  style={{ width: `${Math.min(100, Math.round(row.claudeShare * 1000) / 10)}%` }}
                />
              </dd>
            )}
            <ClaudeLimitCell
              row={row}
              t={t}
              locale={locale}
              now={now}
              onSave={onSaveLimit}
              onResetWindow={onResetWindow}
            />
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>{t('dashboard.client_usage_col_tokens')}</dt>
            <dd className={styles.metricValue}>
              {row.used ? formatCompactNumber(row.week.tokens) : DASH}
            </dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>{t('dashboard.client_usage_col_requests')}</dt>
            <dd className={styles.metricValue}>
              {row.used ? row.week.requests.toLocaleString(locale) : DASH}
              {row.week.failed > 0 && (
                <span className={`${styles.metricAside} ${styles.failed}`}>
                  {t('dashboard.client_usage_failed', {
                    value: row.week.failed.toLocaleString(locale),
                  })}
                </span>
              )}
              {row.week.blocked > 0 && (
                <span className={`${styles.metricAside} ${styles.blocked}`}>
                  {t('dashboard.client_usage_blocked', {
                    value: row.week.blocked.toLocaleString(locale),
                  })}
                </span>
              )}
            </dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>{t('dashboard.client_usage_col_last_used')}</dt>
            <dd className={styles.metricText}>
              {row.lastUsedAtMs === null || lastUsed === null ? (
                t('dashboard.client_usage_unused')
              ) : (
                <time
                  dateTime={new Date(row.lastUsedAtMs).toISOString()}
                  title={new Date(row.lastUsedAtMs).toLocaleString(locale)}
                >
                  {lastUsed}
                </time>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {hasDetails && (
        <details className={styles.details}>
          <summary className={styles.detailsSummary}>
            <IconChevronDown size={14} className={styles.chevron} aria-hidden="true" />
            {t('dashboard.client_usage_details')}
          </summary>
          <div className={styles.detailsBody}>
            {claudeCredentials.length > 0 && (
              <div className={styles.detailsGroup}>
                <span className={styles.detailsTitle}>
                  {t('dashboard.client_usage_claude_breakdown')}
                </span>
                <ul className={styles.detailsList}>
                  {claudeCredentials.map((credential) => (
                    <li key={credential.authId}>
                      {[
                        claudeCredentialName(credential, credentialLabels),
                        claudePlanLabel(t, credential.plan, credential.planSource),
                        t('dashboard.client_usage_credential_share', {
                          value: formatLimitFraction(credential.currentFraction),
                        }),
                        units(credential.currentProUnits),
                      ].join(' · ')}
                    </li>
                  ))}
                </ul>
                {row.claudeTotalProUnits > 0 && (
                  <span className={styles.detailsNote}>
                    {t('dashboard.client_usage_claude_total', {
                      value: units(row.claudeTotalProUnits),
                    })}
                  </span>
                )}
              </div>
            )}
            {row.topModels.length > 0 && (
              <div className={styles.detailsGroup}>
                <span className={styles.detailsTitle}>
                  {t('dashboard.client_usage_top_models')}
                </span>
                <ul className={styles.detailsList}>
                  {row.topModels.map((model) => (
                    <li key={model.model}>
                      <span className={styles.mono}>{model.model}</span>
                      {` · ${t('dashboard.client_usage_model_tokens', {
                        value: formatCompactNumber(model.tokens.total),
                      })}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </li>
  );
}

/**
 * The allowance editor. Native constraint validation is off (`noValidate`): a configured
 * value off the 0.05 spinner step, such as 1.23, must still reach the submit handler,
 * which validates instead. `inputRef` lets the handler read the input's
 * `validity.badInput` flag.
 */
export function ClaudeLimitEditorForm({
  name,
  t,
  draft,
  invalid,
  saving,
  blocked = false,
  hintId,
  inputRef,
  onDraftChange,
  onSubmit,
  onCancel,
  onKeyDown,
}: {
  name: string;
  t: TFunction;
  draft: string;
  invalid: boolean;
  saving: boolean;
  /** Another change to the key (a window reset or removal) is in flight; Save waits. */
  blocked?: boolean;
  hintId: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  // Escape closes the editor from the input and from either button.
  return (
    <form className={styles.limitEditor} noValidate onSubmit={onSubmit} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        type="number"
        inputMode="decimal"
        step="0.05"
        min="0"
        className={`input ${styles.limitInput}`}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        disabled={saving}
        autoFocus
        aria-label={t('dashboard.client_usage_limit_input_label', { name })}
        aria-describedby={hintId}
        aria-invalid={invalid || undefined}
      />
      <Button
        type="submit"
        variant="primary"
        size="sm"
        className={styles.limitAction}
        loading={saving}
        disabled={blocked}
        aria-label={t('dashboard.client_usage_limit_save', { name })}
      >
        {t('common.save')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={styles.limitAction}
        onClick={onCancel}
        disabled={saving}
        aria-label={t('dashboard.client_usage_limit_cancel', { name })}
      >
        {t('common.cancel')}
      </Button>
      <span
        id={hintId}
        className={invalid ? `${styles.limitHint} ${styles.limitHintInvalid}` : styles.limitHint}
      >
        {t(
          invalid
            ? 'dashboard.client_usage_limit_invalid'
            : blocked
              ? 'dashboard.client_usage_key_busy'
              : 'dashboard.client_usage_limit_hint'
        )}
      </span>
    </form>
  );
}

/**
 * Allowance meter and "used / limit" line, with an inline editor when the backend
 * enforces limits and the dashboard is connected. Enter saves, Escape cancels, and focus
 * returns to the edit button when the editor closes.
 */
/**
 * The allowance meter and editor, plus the key's open 7-day window with its reset
 * control. The reset time shows only for keys with an allowance, which the window's end
 * restores. The reset asks for confirmation inline, like the editor, and keeps the row
 * in place while the backend ends the window.
 */
function ClaudeLimitCell({
  row,
  t,
  locale,
  now,
  onSave,
  onResetWindow,
}: {
  row: ClientUsageRow;
  t: TFunction;
  locale: string;
  now: number;
  onSave?: SaveClientLimit;
  onResetWindow?: ResetClientWindow;
}) {
  const showNotification = useNotificationStore((state) => state.showNotification);
  // The change was made; say so, and that the row may not show it yet.
  const notifyUnrefreshed = (refreshed: boolean | void, key: string) => {
    const notice = unrefreshedChangeNotice(refreshed, key);
    if (notice) showNotification(t(notice.key), notice.type);
  };
  const status = row.claudeLimit;
  const period = row.claudeWindow;
  const name = row.label.text;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reset, dispatchReset] = useReducer(windowResetConfirmReducer, initialWindowResetConfirm);
  const resetting = reset.resetting;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef(false);
  const hintId = useId();
  // Save, reset and removal of a key exclude one another; each control waits while
  // another holds the key.
  const locked = useClientKeyMutation(row.id) !== null;
  const windowIdentity = claudeWindowIdentity(period);
  const confirming = windowResetConfirming(reset, windowIdentity);

  useEffect(() => {
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [editing]);

  // A confirmation is dropped once the window it was asked about ends or changes
  // (a poll removed it, a later request opened another), never carried over.
  useEffect(() => {
    dispatchReset({ type: 'window', window: windowIdentity });
  }, [windowIdentity]);

  // Opening moves focus into the confirmation (the trigger it replaces is gone), on the
  // safe choice; closing returns it to the trigger, or to the allowance editor's button
  // when the window is gone and the trigger with it.
  useEffect(() => {
    if (confirming) {
      keepRef.current?.focus();
      return;
    }
    if (!reset.restoreFocus) return;
    dispatchReset({ type: 'focus-restored' });
    (resetTriggerRef.current ?? triggerRef.current)?.focus();
  }, [confirming, reset.restoreFocus]);

  // Without an allowance the window's end changes nothing the key is held to; with a
  // reached one, its badge already says when the window resets.
  const showResetTime = status !== null && !status.reached;
  const showWindowLine = period !== null && (showResetTime || onResetWindow !== undefined);

  if (!status && !onSave && !showWindowLine) return null;

  const openConfirm = () => {
    if (windowIdentity !== null) dispatchReset({ type: 'open', window: windowIdentity });
  };

  const handleReset = async () => {
    if (!onResetWindow || resetting) return;
    dispatchReset({ type: 'reset' });
    try {
      const refreshed = await clientKeyMutations.run(row.id, 'reset', () => onResetWindow(row.id));
      dispatchReset({ type: 'reset-succeeded' });
      notifyUnrefreshed(refreshed, 'dashboard.client_usage_window_reset_stale');
    } catch (error) {
      // Stay open so the reset can be retried.
      showNotification(
        t(
          isClientKeyBusy(error)
            ? 'dashboard.client_usage_key_busy'
            : 'dashboard.client_usage_window_reset_error'
        ),
        'error'
      );
      dispatchReset({ type: 'reset-failed' });
    }
  };

  const handleConfirmKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !resetting) {
      event.preventDefault();
      dispatchReset({ type: 'cancel' });
    }
  };

  const openEditor = () => {
    setDraft(formatClaudeLimitInput(status?.limit ?? null));
    setInvalid(false);
    setEditing(true);
  };

  const closeEditor = () => {
    restoreFocusRef.current = true;
    setEditing(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onSave || saving) return;
    const value = parseClaudeLimitInput(draft, inputRef.current?.validity.badInput ?? false);
    if (value === undefined) {
      setInvalid(true);
      return;
    }
    setSaving(true);
    try {
      // Refused, not queued, while the key is being reset or removed: a save applied
      // after a removal would bring the removed key back.
      const refreshed = await clientKeyMutations.run(row.id, 'save', () => onSave(row.id, value));
      closeEditor();
      notifyUnrefreshed(refreshed, 'dashboard.client_usage_limit_saved_stale');
    } catch (error) {
      // Stay open so the value can be corrected or retried.
      showNotification(
        t(
          isClientKeyBusy(error)
            ? 'dashboard.client_usage_key_busy'
            : 'dashboard.client_usage_limit_save_error'
        ),
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      closeEditor();
    }
  };

  const editLabel = t('dashboard.client_usage_limit_edit', { name });

  return (
    <>
      {status && (
        <dd className={styles.limitMeter}>
          <Meter
            value={status.fraction * 100}
            tone={claudeLimitTone(status)}
            ariaLabel={t('dashboard.client_usage_limit_meter_label', { name })}
          />
        </dd>
      )}
      <dd className={styles.limit}>
        {editing && onSave ? (
          <ClaudeLimitEditorForm
            name={name}
            t={t}
            draft={draft}
            invalid={invalid}
            saving={saving}
            blocked={locked && !saving}
            hintId={hintId}
            inputRef={inputRef}
            onDraftChange={(value) => {
              setDraft(value);
              setInvalid(false);
            }}
            onSubmit={(event) => void handleSubmit(event)}
            onCancel={closeEditor}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className={styles.limitText}>
            <span>
              {status
                ? t('dashboard.client_usage_limit_meter', formatLimitMeterValues(status, locale))
                : t('dashboard.client_usage_limit_none')}
            </span>
            {onSave && (
              <Button
                ref={triggerRef}
                type="button"
                variant="ghost"
                size="sm"
                className={styles.limitEdit}
                onClick={openEditor}
                disabled={locked}
                aria-label={editLabel}
                title={editLabel}
              >
                <IconPencil size={12} aria-hidden="true" />
              </Button>
            )}
          </span>
        )}
        {status?.reached && (
          <span className={`${styles.badge} ${styles.limitReached}`}>
            {t('dashboard.client_usage_limit_reached')}
            {status.resetsAtMs !== null && (
              <>
                {' · '}
                <time
                  dateTime={new Date(status.resetsAtMs).toISOString()}
                  title={new Date(status.resetsAtMs).toLocaleString(locale)}
                >
                  {t('dashboard.client_usage_resets', {
                    time: formatRelativeInstant(status.resetsAtMs, now, locale),
                  })}
                </time>
              </>
            )}
          </span>
        )}
        {period && showWindowLine && (
          <span className={styles.windowLine}>
            {showResetTime && (
              <time
                dateTime={new Date(period.resetsAtMs).toISOString()}
                title={new Date(period.resetsAtMs).toLocaleString(locale)}
              >
                {t('dashboard.client_usage_resets', {
                  time: formatRelativeInstant(period.resetsAtMs, now, locale),
                })}
              </time>
            )}
            {onResetWindow &&
              (confirming ? (
                <WindowResetConfirm
                  name={name}
                  t={t}
                  resetting={resetting}
                  blocked={locked && !resetting}
                  keepRef={keepRef}
                  onConfirm={() => void handleReset()}
                  onCancel={() => dispatchReset({ type: 'cancel' })}
                  onKeyDown={handleConfirmKeyDown}
                />
              ) : (
                <Button
                  ref={resetTriggerRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.windowReset}
                  onClick={openConfirm}
                  disabled={locked}
                  aria-label={t('dashboard.client_usage_window_reset_label', { name })}
                  title={t('dashboard.client_usage_window_reset_hint')}
                >
                  {t('dashboard.client_usage_window_reset')}
                </Button>
              ))}
          </span>
        )}
      </dd>
    </>
  );
}

/**
 * The inline confirmation of a window reset. Keep is the safe choice and receives focus
 * through `keepRef` when the confirmation opens; Escape is handled on the whole group.
 */
export function WindowResetConfirm({
  name,
  t,
  resetting,
  blocked = false,
  keepRef,
  onConfirm,
  onCancel,
  onKeyDown,
}: {
  name: string;
  t: TFunction;
  resetting: boolean;
  /** Another change to the key (an allowance save or removal) is in flight; Reset waits. */
  blocked?: boolean;
  keepRef: RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <span
      className={styles.windowConfirm}
      role="group"
      aria-label={t('dashboard.client_usage_window_reset_confirm', { name })}
      onKeyDown={onKeyDown}
    >
      <span>{t('dashboard.client_usage_window_reset_confirm', { name })}</span>
      <Button
        type="button"
        variant="danger"
        size="sm"
        className={styles.limitAction}
        onClick={onConfirm}
        loading={resetting}
        disabled={blocked}
        aria-label={t('dashboard.client_usage_window_reset_yes_label', { name })}
      >
        {t('dashboard.client_usage_window_reset_yes')}
      </Button>
      <Button
        ref={keepRef}
        type="button"
        variant="ghost"
        size="sm"
        className={styles.limitAction}
        onClick={onCancel}
        disabled={resetting}
      >
        {t('dashboard.client_usage_window_reset_no')}
      </Button>
    </span>
  );
}

/**
 * Removes a key that is no longer in config from the list: its allowance, when it has one,
 * and its usage history. The confirmation replaces the trigger inline, like the window
 * reset, and stays open to retry when the removal fails.
 */
function RemoveKeyControl({
  row,
  t,
  onRemove,
}: {
  row: ClientUsageRow;
  t: TFunction;
  onRemove: RemoveRow;
}) {
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const name = row.label.text;
  const locked = useClientKeyMutation(row.id) !== null;

  // Opening moves focus to Keep, the safe choice; closing returns it to the trigger.
  useEffect(() => {
    if (confirming) {
      keepRef.current?.focus();
      return;
    }
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [confirming]);

  const close = () => {
    restoreFocusRef.current = true;
    setConfirming(false);
  };

  const handleRemove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      // Held through the removal and the reload after it, so no allowance save or window
      // reset of the key can slip in between.
      await clientKeyMutations.run(row.id, 'remove', () => onRemove(row.id));
      // The reload normally drops the row; it stays only when the reload failed.
      close();
    } catch (error) {
      // Stay open so the removal can be retried.
      showNotification(
        t(
          isClientKeyBusy(error)
            ? 'dashboard.client_usage_key_busy'
            : 'dashboard.client_usage_remove_error'
        ),
        'error'
      );
    } finally {
      setRemoving(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !removing) {
      event.preventDefault();
      close();
    }
  };

  if (confirming) {
    return (
      <RemoveKeyConfirm
        name={name}
        t={t}
        withLimit={row.claudeLimit !== null}
        removing={removing}
        blocked={locked && !removing}
        keepRef={keepRef}
        onConfirm={() => void handleRemove()}
        onCancel={close}
        onKeyDown={handleKeyDown}
      />
    );
  }
  return (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      size="sm"
      className={styles.removeAction}
      onClick={() => setConfirming(true)}
      disabled={locked}
      aria-label={t('dashboard.client_usage_remove_label', { name })}
      title={t('dashboard.client_usage_remove_hint')}
    >
      {t('dashboard.client_usage_remove')}
    </Button>
  );
}

/**
 * The inline confirmation of a key removal, which says when the row's allowance goes too.
 * Keep is the safe choice and receives focus through `keepRef` when the confirmation
 * opens; Escape is handled on the whole group.
 */
export function RemoveKeyConfirm({
  name,
  t,
  withLimit,
  removing,
  blocked = false,
  keepRef,
  onConfirm,
  onCancel,
  onKeyDown,
}: {
  name: string;
  t: TFunction;
  withLimit: boolean;
  removing: boolean;
  /** Another change to the key (an allowance save or window reset) is in flight; Remove waits. */
  blocked?: boolean;
  keepRef: RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const question = t(
    withLimit
      ? 'dashboard.client_usage_remove_confirm_limit'
      : 'dashboard.client_usage_remove_confirm',
    { name }
  );
  return (
    <span className={styles.removeConfirm} role="group" aria-label={question} onKeyDown={onKeyDown}>
      <span>{question}</span>
      <Button
        type="button"
        variant="danger"
        size="sm"
        className={styles.removeAction}
        onClick={onConfirm}
        loading={removing}
        disabled={blocked}
        aria-label={t('dashboard.client_usage_remove_yes_label', { name })}
      >
        {t('dashboard.client_usage_remove')}
      </Button>
      <Button
        ref={keepRef}
        type="button"
        variant="ghost"
        size="sm"
        className={styles.removeAction}
        onClick={onCancel}
        disabled={removing}
      >
        {t('dashboard.client_usage_remove_no')}
      </Button>
    </span>
  );
}

function CredentialCard({
  credential,
  name,
  t,
  locale,
  now,
}: {
  credential: ClaudeCredentialUsage;
  name: string;
  t: TFunction;
  locale: string;
  now: number;
}) {
  const plan = claudePlanLabel(t, credential.plan, credential.planSource);
  const allowance = t('dashboard.client_usage_plan_allowance', {
    value: formatPlanAllowance(credential.planProUnits, locale),
  });
  const open = credential.windowResetsAtMs !== null && credential.windowResetsAtMs > now;
  const utilization = open ? credential.weeklyUtilization : 0;

  return (
    <li className={styles.credential}>
      <div className={styles.credentialHead}>
        <span className={styles.credentialName} title={credential.authId}>
          {name}
        </span>
        <span className={styles.credentialPlan}>{`${plan} · ${allowance}`}</span>
      </div>
      <Meter
        value={utilization * 100}
        tone={weeklyUtilizationTone(utilization)}
        ariaLabel={t('dashboard.client_usage_utilization_label', { name })}
        className={styles.credentialMeter}
      />
      {open && credential.windowResetsAtMs !== null ? (
        <span className={styles.credentialNote}>
          {`${t('dashboard.client_usage_utilization', {
            value: formatLimitFraction(utilization),
          })} · `}
          <time
            dateTime={new Date(credential.windowResetsAtMs).toISOString()}
            title={new Date(credential.windowResetsAtMs).toLocaleString(locale)}
          >
            {t('dashboard.client_usage_resets', {
              time: formatRelativeInstant(credential.windowResetsAtMs, now, locale),
            })}
          </time>
        </span>
      ) : (
        <span className={styles.credentialNote}>{t('dashboard.client_usage_window_closed')}</span>
      )}
      {open && credential.unattributedCurrentFraction > 0 && (
        <span className={styles.credentialNote}>
          {t('dashboard.client_usage_unattributed', {
            value: formatLimitFraction(credential.unattributedCurrentFraction),
          })}
        </span>
      )}
    </li>
  );
}
