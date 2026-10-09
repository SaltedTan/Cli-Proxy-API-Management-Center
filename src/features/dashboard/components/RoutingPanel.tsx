import { useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { cooldownReasonKey } from '@/features/authFiles/cooldowns';
import type { Config } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { RoutingDecision } from '@/types/routing';
import { formatPercent } from '@/utils/format';
import { createSharedClock } from '@/utils/time/sharedClock';
import type { RoutingObservabilityState } from '../hooks/useRoutingObservability';
import {
  affinityReuseRate,
  buildCredentialLabels,
  formatRoutingDuration,
  formatRoutingTtl,
  detectStrategyDrift,
  quotaReasonLabelKeys,
  routingAttemptTone,
  routingSelectionLabelKey,
  routingSelectionTone,
  routingStrategyLabelKey,
  shortAuthIndex,
  summarizeRoutingPool,
  type RoutingTone,
} from '../routing';
import { providerLabel } from '../utils';
import { StaleDataNotice } from './StaleDataNotice';
import dash from '../dashboard.module.scss';
import styles from './RoutingPanel.module.scss';

const DASH = '—';
const COLLAPSED_ROWS = 8;

// Cooldown estimates only need coarse ticks on the dashboard.
const clock = createSharedClock({ intervalMs: 15_000 });

const TONE_CLASS: Record<RoutingTone, string> = {
  good: styles.toneGood,
  warning: styles.toneWarning,
  critical: styles.toneCritical,
  neutral: styles.toneNeutral,
};

export interface RoutingPanelProps {
  routing: RoutingObservabilityState;
  config: Config | null;
  authFiles: AuthFileItem[] | null;
  /** Reloads this panel's data without the rest of the dashboard; omitted hides the button. */
  onRefresh?: () => Promise<unknown>;
  /** Injected by tests; the live panel follows the shared clock. */
  nowMs?: number;
}

export function RoutingPanel({ routing, config, authFiles, onRefresh, nowMs }: RoutingPanelProps) {
  const { t, i18n } = useTranslation();
  const tickMs = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const now = nowMs ?? tickMs;
  const [expanded, setExpanded] = useState(false);
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

  const live = routing.status === 'ready' ? routing.data : null;
  const homeMode = live?.mode === 'home';

  const labels = useMemo(() => buildCredentialLabels(authFiles, config), [authFiles, config]);
  const pool = useMemo(
    () => (authFiles ? summarizeRoutingPool(authFiles, now) : null),
    [authFiles, now]
  );

  const credentialName = (authIndex: string) => labels.get(authIndex) ?? shortAuthIndex(authIndex);
  const formatTime = (ms: number | null) =>
    ms === null
      ? DASH
      : new Date(ms).toLocaleTimeString(i18n.language, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

  /* ---- Strategy ---- */
  const strategyValue = live?.strategy || config?.routingStrategy?.trim() || 'round-robin';
  const strategyKey = routingStrategyLabelKey(strategyValue);
  const strategyLabel = strategyKey ? t(strategyKey) : strategyValue;
  // Drift is only meaningful once the config is loaded; a blank strategy means the default.
  const drift = live && config ? detectStrategyDrift(config.routingStrategy, live.strategy) : null;
  let strategyNote: { text: string; tone: RoutingTone };
  if (drift?.kind === 'unrecognized') {
    strategyNote = {
      text: t('dashboard.routing_strategy_unrecognized', { value: drift.configured }),
      tone: 'warning',
    };
  } else if (drift?.kind === 'differs') {
    strategyNote = {
      text: t('dashboard.routing_strategy_differs', { value: drift.configured }),
      tone: 'warning',
    };
  } else if (live?.pluginScheduler) {
    strategyNote = { text: t('dashboard.routing_strategy_plugin'), tone: 'neutral' };
  } else {
    strategyNote = {
      text: t(live ? 'dashboard.routing_strategy_live' : 'dashboard.routing_strategy_configured'),
      tone: 'neutral',
    };
  }

  /* ---- Session affinity ---- */
  const affinityEnabled = live
    ? live.sessionAffinity.enabled
    : Boolean(config?.routingSessionAffinity);
  const affinityTtl = live?.sessionAffinity.ttlSeconds;
  const affinityValue = affinityEnabled
    ? affinityTtl
      ? t('dashboard.routing_affinity_on_ttl', { ttl: formatRoutingTtl(t, affinityTtl) })
      : t('dashboard.routing_affinity_on')
    : t('dashboard.routing_affinity_off');
  let affinityNote: string;
  if (!affinityEnabled) {
    affinityNote = t('dashboard.routing_affinity_off_hint');
  } else if (!live) {
    affinityNote = t('dashboard.routing_affinity_pending');
  } else {
    const reuse = affinityReuseRate(live.counters);
    affinityNote = [
      t('dashboard.routing_affinity_sessions', {
        sessions: live.sessionAffinity.activeSessions.toLocaleString(),
        credentials: Object.keys(live.sessionAffinity.sessionsByAuthIndex).length,
      }),
      reuse === null ? null : t('dashboard.routing_affinity_reuse', { rate: formatPercent(reuse) }),
      t('dashboard.routing_affinity_switches', { value: live.counters.affinityRebinds }),
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /* ---- Failover ---- */
  const failoverNote = live
    ? [
        t('dashboard.routing_retries', { value: live.counters.retries }),
        live.sinceMs === null
          ? t('dashboard.routing_selections', {
              value: live.counters.selections.toLocaleString(),
            })
          : t('dashboard.routing_selections_since', {
              value: live.counters.selections.toLocaleString(),
              time: new Date(live.sinceMs).toLocaleString(i18n.language),
            }),
      ].join(' · ')
    : t('dashboard.routing_failover_unavailable');

  /* ---- Notices ---- */
  let notice: string | null = null;
  if (homeMode) notice = t('dashboard.routing_notice_home');
  else if (routing.status === 'unsupported') notice = t('dashboard.routing_notice_unsupported');
  else if (routing.status === 'error') notice = t('dashboard.routing_notice_error');

  const decisions = live && !homeMode ? live.recent : [];
  const visibleDecisions = expanded ? decisions : decisions.slice(0, COLLAPSED_ROWS);
  const showTransport = decisions.some((decision) => Boolean(decision.transport));
  const showSession = decisions.some((decision) => Boolean(decision.session));
  const transportTotal = live ? live.counters.transportWebsocket + live.counters.transportHttp : 0;
  const unknownProvider = t('dashboard.provider_unknown');
  // A failed refresh keeps the last snapshot, flagged stale below, and this time with it.
  const observedAt = live?.observedAtMs ?? null;

  return (
    <div className={dash.panel}>
      {(onRefresh || observedAt !== null) && (
        <div className={styles.toolbar}>
          {observedAt !== null && (
            <span className={styles.updated}>
              {t('dashboard.routing_updated_at', { time: formatTime(observedAt) })}
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
              aria-label={t('dashboard.routing_refresh_label')}
              title={t('dashboard.routing_refresh_hint')}
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

      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {live && routing.stale && (
        <StaleDataNotice
          t={t}
          locale={i18n.language}
          updatedAtMs={routing.updatedAtMs}
          now={now}
          onRetry={onRefresh ? () => void handleRefresh() : undefined}
          retrying={refreshing}
          retryLabel={t('dashboard.routing_refresh_label')}
        />
      )}

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('dashboard.routing_strategy')}</dt>
          <dd className={styles.factValue}>{strategyLabel}</dd>
          <dd className={`${styles.factNote} ${TONE_CLASS[strategyNote.tone]}`}>
            {strategyNote.text}
          </dd>
        </div>

        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('dashboard.routing_affinity')}</dt>
          <dd className={styles.factValue}>{affinityValue}</dd>
          <dd className={styles.factNote}>{affinityNote}</dd>
        </div>

        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('dashboard.routing_pool')}</dt>
          <dd className={styles.factValue}>
            {pool && pool.total > 0
              ? t('dashboard.routing_pool_value', { ready: pool.ready, total: pool.total })
              : DASH}
          </dd>
          {pool && pool.total > 0 ? (
            <>
              <dd className={styles.factBar} aria-hidden="true">
                {[
                  { key: 'ready', count: pool.ready, className: dash.healthActive },
                  { key: 'cooling', count: pool.cooling, className: styles.segmentCooling },
                  {
                    key: 'unavailable',
                    count: pool.unavailable,
                    className: dash.healthUnavailable,
                  },
                  { key: 'disabled', count: pool.disabled, className: dash.healthDisabled },
                ]
                  .filter((segment) => segment.count > 0)
                  .map((segment) => (
                    <span
                      key={segment.key}
                      className={`${dash.healthSegment} ${segment.className}`}
                      style={{ flexGrow: segment.count }}
                    />
                  ))}
              </dd>
              <dd className={styles.factNote}>
                {t('dashboard.routing_pool_breakdown', {
                  cooling: pool.cooling,
                  unavailable: pool.unavailable,
                  disabled: pool.disabled,
                })}
              </dd>
              {pool.nextRecovery && (
                <dd className={`${styles.factNote} ${styles.toneWarning}`}>
                  {t('dashboard.routing_pool_next', {
                    time: formatRoutingDuration(t, pool.nextRecovery.seconds),
                    reason: t(cooldownReasonKey(pool.nextRecovery.reason)),
                  })}
                </dd>
              )}
            </>
          ) : (
            <dd className={styles.factNote}>{t('dashboard.routing_pool_empty')}</dd>
          )}
        </div>

        <div className={styles.fact}>
          <dt className={styles.factLabel}>{t('dashboard.routing_failovers')}</dt>
          <dd className={styles.factValue}>
            {live ? live.counters.failovers.toLocaleString() : DASH}
          </dd>
          <dd className={styles.factNote}>{failoverNote}</dd>
        </div>
      </dl>

      {live && !homeMode && (
        <div className={styles.recent}>
          <div className={styles.recentHead}>
            <h3 className={styles.recentTitle}>{t('dashboard.routing_recent_title')}</h3>
            {transportTotal > 0 && (
              <span className={styles.recentMeta}>
                {t('dashboard.routing_transport_summary', {
                  websocket: live.counters.transportWebsocket.toLocaleString(),
                  http: live.counters.transportHttp.toLocaleString(),
                })}
              </span>
            )}
          </div>
          {decisions.length === 0 ? (
            <p className={dash.emptyNote}>{t('dashboard.routing_recent_empty')}</p>
          ) : (
            <Table className={styles.table}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('dashboard.routing_col_time')}</TableHead>
                  <TableHead>{t('dashboard.routing_col_route')}</TableHead>
                  <TableHead>{t('dashboard.routing_col_credential')}</TableHead>
                  <TableHead>{t('dashboard.routing_col_decision')}</TableHead>
                  <TableHead alignRight title={t('dashboard.routing_col_ready_hint')}>
                    {t('dashboard.routing_col_ready')}
                  </TableHead>
                  <TableHead>{t('dashboard.routing_col_attempt')}</TableHead>
                  {showSession && (
                    <TableHead title={t('dashboard.routing_col_session_hint')}>
                      {t('dashboard.routing_col_session')}
                    </TableHead>
                  )}
                  {showTransport && <TableHead>{t('dashboard.routing_col_transport')}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleDecisions.map((decision, index) => (
                  <DecisionRow
                    key={`${decision.timeMs ?? 0}-${index}`}
                    decision={decision}
                    t={t}
                    time={formatTime(decision.timeMs)}
                    provider={providerLabel(decision.provider, unknownProvider)}
                    credential={credentialName(decision.authIndex)}
                    previous={
                      decision.previousAuthIndex
                        ? credentialName(decision.previousAuthIndex)
                        : undefined
                    }
                    showSession={showSession}
                    showTransport={showTransport}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {decisions.length > COLLAPSED_ROWS && (
            <Button
              variant="ghost"
              size="sm"
              className={styles.toggle}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? t('dashboard.routing_recent_show_less')
                : t('dashboard.routing_recent_show_all', { value: decisions.length })}
            </Button>
          )}
        </div>
      )}

      <p className={styles.footnote}>{t('dashboard.routing_footnote')}</p>
      <Link to="/config" className={dash.panelLink}>
        {t('dashboard.routing_link')}{' '}
        <span className={dash.linkArrow} aria-hidden="true">
          →
        </span>
      </Link>
    </div>
  );
}

function DecisionRow({
  decision,
  t,
  time,
  provider,
  credential,
  previous,
  showSession,
  showTransport,
}: {
  decision: RoutingDecision;
  t: TFunction;
  time: string;
  provider: string;
  credential: string;
  previous?: string;
  showSession: boolean;
  showTransport: boolean;
}) {
  const selectionTone = routingSelectionTone(decision.selection);
  const attemptTone = routingAttemptTone(decision.attemptKind);
  const attemptLabel =
    decision.attemptKind === 'failover'
      ? t('dashboard.routing_attempt_failover', { attempt: decision.attempt })
      : decision.attemptKind === 'retry'
        ? t('dashboard.routing_attempt_retry', { attempt: decision.attempt })
        : t('dashboard.routing_attempt_initial');
  const reasons = quotaReasonLabelKeys(decision.strategyReason).map((key) => t(key));
  const transportLabel =
    decision.transport === 'websocket'
      ? t('dashboard.routing_transport_websocket')
      : decision.transport === 'http'
        ? t('dashboard.routing_transport_http')
        : decision.transport || DASH;

  return (
    <TableRow>
      <TableCell className={styles.mono}>{time}</TableCell>
      <TableCell>
        <span className={styles.primary}>{provider}</span>
        {decision.model && (
          <span className={`${styles.secondary} ${styles.mono}`}>{decision.model}</span>
        )}
      </TableCell>
      <TableCell>
        <span className={styles.primary} title={decision.authIndex}>
          {credential}
        </span>
        {previous && (
          <span className={styles.secondary}>
            {t('dashboard.routing_previous', { credential: previous })}
          </span>
        )}
      </TableCell>
      <TableCell>
        <span className={`${styles.badge} ${TONE_CLASS[selectionTone]}`}>
          {t(routingSelectionLabelKey(decision.selection))}
        </span>
        {reasons.length > 0 && <span className={styles.secondary}>{reasons.join(' · ')}</span>}
      </TableCell>
      <TableCell alignRight className={styles.mono}>
        {decision.candidates ?? DASH}
      </TableCell>
      <TableCell>
        <span className={`${styles.badge} ${TONE_CLASS[attemptTone]}`}>{attemptLabel}</span>
      </TableCell>
      {showSession && <TableCell className={styles.mono}>{decision.session ?? DASH}</TableCell>}
      {showTransport && <TableCell>{transportLabel}</TableCell>}
    </TableRow>
  );
}
