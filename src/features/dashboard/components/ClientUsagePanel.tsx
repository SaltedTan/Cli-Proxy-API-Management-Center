import { useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { IconChevronDown, IconRefreshCw } from '@/components/ui/icons';
import type { ClaudeCredentialUsage } from '@/types/clientUsage';
import { formatCompactNumber, formatPercent } from '@/utils/format';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { createSharedClock } from '@/utils/time/sharedClock';
import type { ClientUsageState } from '../hooks/useClientUsage';
import {
  buildClientUsageRows,
  claudePlanLabel,
  clientUsageHints,
  clientUsageToday,
  formatLimitFraction,
  formatPlanAllowance,
  formatProUnits,
  weeklyUtilizationTone,
  type ClientUsageHint,
  type ClientUsageRow,
} from '../clientUsage';
import { Meter } from './Meter';
import dash from '../dashboard.module.scss';
import styles from './ClientUsagePanel.module.scss';

const DASH = '—';
const API_KEYS_ROUTE = '/config?field=apiKeys';

// Last-used and reset times only need coarse ticks.
const clock = createSharedClock({ intervalMs: 30_000 });

export interface ClientUsagePanelProps {
  usage: ClientUsageState;
  /** Names saved in this browser for configured keys, by key id. */
  localNames: ReadonlyMap<string, string>;
  /** Reloads this panel's data without the rest of the dashboard; omitted hides the button. */
  onRefresh?: () => Promise<void>;
  /** Injected by tests; the live panel follows the shared clock. */
  nowMs?: number;
}

export function ClientUsagePanel({ usage, localNames, onRefresh, nowMs }: ClientUsagePanelProps) {
  const { t, i18n } = useTranslation();
  const tickMs = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const now = nowMs ?? tickMs;
  const locale = i18n.language;
  const [refreshing, setRefreshing] = useState(false);

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
          })
        : [],
    [data, localNames, anonymousLabel, now]
  );
  const hints = useMemo(() => (data ? clientUsageHints(data.keys) : []), [data]);
  const anyUsage = rows.some((row) => row.used);

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
          <ul className={styles.rows} aria-label={t('dashboard.client_usage_list_label')}>
            {rows.map((row) => (
              <UsageRow key={row.id} row={row} t={t} locale={locale} now={now} />
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
}: {
  row: ClientUsageRow;
  t: TFunction;
  locale: string;
  now: number;
}) {
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

  return (
    <li className={row.used ? styles.row : `${styles.row} ${styles.unused}`}>
      <div className={styles.rowMain}>
        <div className={styles.identity}>
          <span className={styles.name} title={row.label.text}>
            {row.label.text}
          </span>
          {(row.secondary || (!row.configured && !row.anonymous)) && (
            <span className={styles.identityMeta}>
              {row.secondary && <span className={styles.mono}>{row.secondary}</span>}
              {!row.configured && !row.anonymous && (
                <span className={styles.badge}>{t('dashboard.client_usage_not_in_config')}</span>
              )}
            </span>
          )}
        </div>

        <dl className={styles.metrics}>
          <div className={styles.metric}>
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
            {row.claudeShare !== null && (
              <dd className={styles.shareTrack} aria-hidden="true">
                <span
                  className={styles.shareFill}
                  style={{ width: `${Math.min(100, Math.round(row.claudeShare * 1000) / 10)}%` }}
                />
              </dd>
            )}
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
                        credential.label || credential.authId,
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

function CredentialCard({
  credential,
  t,
  locale,
  now,
}: {
  credential: ClaudeCredentialUsage;
  t: TFunction;
  locale: string;
  now: number;
}) {
  const name = credential.label || credential.authId;
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
