import { describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';
import { apiClient } from '@/services/api/client';
import { normalizeRoutingObservability, routingApi } from '@/services/api/routing';
import { normalizeConfigResponse } from '@/services/api/transformers';
import { normalizeAuthFileCooldowns } from '@/services/api/authFileCooldowns';
import { RoutingPanel } from '@/features/dashboard/components/RoutingPanel';
import type { RoutingObservabilityState } from '@/features/dashboard/hooks/useRoutingObservability';
import {
  affinityReuseRate,
  buildCredentialLabels,
  detectStrategyDrift,
  formatRoutingTtl,
  normalizeRoutingStrategy,
  quotaReasonLabelKeys,
  routingStrategyLabelKey,
  summarizeRoutingPool,
} from '@/features/dashboard/routing';
import type { Config } from '@/types';
import type { AuthFileItem } from '@/types/authFile';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  // Mirrors the app config: React escapes rendered text.
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const NOW = Date.parse('2026-10-04T10:00:00Z');

const rawSnapshot = {
  observed_at: '2026-10-04T10:00:00Z',
  since: '2026-10-04T08:00:00Z',
  mode: 'local',
  strategy: 'quota-aware',
  plugin_scheduler: false,
  session_affinity: {
    enabled: true,
    ttl_seconds: 3600,
    subagents: true,
    active_sessions: 3,
    sessions_by_auth_index: { idx_a: 2, idx_b: 1, '': 4 },
  },
  counters: {
    selections: 120,
    retries: 1,
    failovers: 3,
    affinity_hits: 90,
    affinity_new: 8,
    affinity_rebinds: 2,
    transport_websocket: 40,
    transport_http: 10,
  },
  recent: [
    {
      time: '2026-10-04T09:59:58Z',
      provider: 'codex',
      model: 'gpt-5',
      auth_index: 'idx_b',
      selection: 'affinity_rebind',
      strategy_reason: 'weekly_pace,all_short_saturated',
      candidates: 2,
      attempt: 2,
      attempt_kind: 'failover',
      previous_auth_index: 'idx_a',
      session: '9c1e44d0',
      transport: 'websocket',
    },
    { time: '0001-01-01T00:00:00Z', provider: 'claude', auth_index: 'idx_c', attempt: 0 },
    { provider: 'claude', selection: 'strategy' },
    'garbage',
  ],
};

const authFiles = [
  { name: 'a.json', email: 'alice@example.com', authIndex: 'idx_a' },
  { name: 'b.json', authIndex: 'idx_b' },
] as AuthFileItem[];

const renderPanel = (
  routing: RoutingObservabilityState,
  options: {
    config?: Config | null;
    files?: AuthFileItem[] | null;
    onRefresh?: () => Promise<void>;
  } = {}
) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        null,
        createElement(RoutingPanel, {
          routing,
          config: options.config ?? null,
          authFiles: options.files === undefined ? authFiles : options.files,
          onRefresh: options.onRefresh,
          nowMs: NOW,
        })
      )
    )
  );

describe('routing observability API', () => {
  test('reads the v8 observability route and normalizes snake_case fields', async () => {
    const get = spyOn(apiClient, 'get').mockResolvedValue(rawSnapshot);
    try {
      const snapshot = await routingApi.getObservability();
      expect(get).toHaveBeenCalledWith('/observability/routing', { timeout: 15000 });
      expect(snapshot.strategy).toBe('quota-aware');
      expect(snapshot.sinceMs).toBe(Date.parse('2026-10-04T08:00:00Z'));
      expect(snapshot.counters.affinityRebinds).toBe(2);
      expect(snapshot.counters.transportHttp).toBe(10);
      expect(snapshot.sessionAffinity).toEqual({
        enabled: true,
        ttlSeconds: 3600,
        subagents: true,
        activeSessions: 3,
        sessionsByAuthIndex: { idx_a: 2, idx_b: 1 },
      });
      expect(snapshot.recent[0]).toEqual({
        timeMs: Date.parse('2026-10-04T09:59:58Z'),
        provider: 'codex',
        model: 'gpt-5',
        authIndex: 'idx_b',
        selection: 'affinity_rebind',
        strategyReason: 'weekly_pace,all_short_saturated',
        candidates: 2,
        attempt: 2,
        attemptKind: 'failover',
        previousAuthIndex: 'idx_a',
        session: '9c1e44d0',
        transport: 'websocket',
      });
    } finally {
      get.mockRestore();
    }
  });

  test('tolerates partial and malformed payloads', () => {
    const snapshot = normalizeRoutingObservability(rawSnapshot);
    // Entries without an auth index cannot be attributed and are dropped.
    expect(snapshot.recent).toHaveLength(2);
    expect(snapshot.recent[1]).toMatchObject({
      timeMs: null,
      authIndex: 'idx_c',
      selection: 'strategy',
      attempt: 1,
      attemptKind: 'initial',
    });
    expect(snapshot.recent[1].candidates).toBeUndefined();

    const empty = normalizeRoutingObservability('nope');
    expect(empty.mode).toBe('local');
    expect(empty.recent).toEqual([]);
    expect(empty.counters.selections).toBe(0);
    expect(empty.sessionAffinity.enabled).toBe(false);
  });

  test('normalizes session affinity from the v8 config tree', () => {
    const config = normalizeConfigResponse({
      routing: { strategy: 'fill-first', 'session-affinity': true, 'session-affinity-ttl': '30m' },
    });
    expect(config.routingSessionAffinity).toBe(true);
    expect(config.routingSessionAffinityTtl).toBe('30m');
    expect(normalizeConfigResponse({}).routingSessionAffinity).toBe(false);
  });

  test('reads the auth_index the v8 config endpoint attaches to each key', () => {
    // Shape captured from GET /v8/management/config on a live backend.
    const config = normalizeConfigResponse({
      'api-keys': {
        'openai-compatibility': [
          {
            name: 'mockai',
            'base-url': 'http://127.0.0.1:18400/v1',
            keys: [
              { 'api-key': 'sk-bad-0001', auth_index: 'a29e1d9c55e5a303' },
              { 'api-key': 'sk-good-0002', auth_index: '627305305fb55d5c' },
            ],
            models: [{ name: 'mock-model', alias: 'e2e-model' }],
          },
        ],
      },
    });
    const entries = config.openaiCompatibility?.[0]?.apiKeyEntries ?? [];
    expect(entries.map((entry) => entry.authIndex)).toEqual([
      'a29e1d9c55e5a303',
      '627305305fb55d5c',
    ]);
    const labels = buildCredentialLabels(null, config);
    expect(labels.get('627305305fb55d5c')).toBe('mockai #2');
  });
});

describe('routing diagnostics', () => {
  test('mirrors backend strategy aliases and flags unrecognized config', () => {
    expect(normalizeRoutingStrategy('')).toBe('round-robin');
    expect(normalizeRoutingStrategy(' WRR ')).toBe('weighted-round-robin');
    expect(normalizeRoutingStrategy('reset-priority')).toBe('quota-aware');
    expect(normalizeRoutingStrategy('fastest')).toBeNull();
    expect(routingStrategyLabelKey('ff')).toBe('dashboard.routing_strategy_fill_first');
    expect(routingStrategyLabelKey('fastest')).toBeNull();

    expect(detectStrategyDrift('qa', 'quota-aware')).toEqual({ kind: 'none' });
    expect(detectStrategyDrift(undefined, 'round-robin')).toEqual({ kind: 'none' });
    expect(detectStrategyDrift('fastest', 'round-robin')).toEqual({
      kind: 'unrecognized',
      configured: 'fastest',
    });
    expect(detectStrategyDrift('fill-first', 'round-robin')).toEqual({
      kind: 'differs',
      configured: 'fill-first',
    });
    expect(detectStrategyDrift('fill-first', 'custom')).toEqual({ kind: 'none' });
  });

  test('classifies the auth-file pool and finds the earliest recovery', () => {
    const cooldowns = (records: unknown[]) =>
      normalizeAuthFileCooldowns(records, '2026-10-04T10:00:00Z', NOW);
    const record = (remaining: number, reason: string, scope = 'model') => ({
      scope,
      ...(scope === 'model' ? { model_key: 'm' } : {}),
      reason,
      retry_at: '2026-10-04T10:10:00Z',
      remaining_seconds: remaining,
    });
    const files = [
      { name: 'ready', cooldownSnapshot: cooldowns([]) },
      { name: 'expired', cooldownSnapshot: cooldowns([record(5, 'quota')]) },
      { name: 'cooling', cooldownSnapshot: cooldowns([record(240, 'quota')]) },
      {
        name: 'blocked',
        unavailable: true,
        cooldownSnapshot: cooldowns([record(90, 'credential_quota', 'credential')]),
      },
      { name: 'off', disabled: true, cooldownSnapshot: cooldowns([record(10, 'unauthorized')]) },
    ] as AuthFileItem[];

    expect(summarizeRoutingPool(files, NOW + 10_000)).toEqual({
      total: 5,
      ready: 2,
      cooling: 1,
      unavailable: 1,
      disabled: 1,
      nextRecovery: { seconds: 80, reason: 'credential_quota' },
      cooldownsReported: true,
    });
    expect(summarizeRoutingPool([{ name: 'legacy' }], NOW).cooldownsReported).toBe(false);
  });

  test('labels credentials without ever using API key values', () => {
    const config = {
      codexApiKeys: [
        { apiKey: 'sk-secret-1', authIndex: 'cfg_1', prefix: 'team' },
        { apiKey: 'sk-secret-2', authIndex: 'cfg_2', baseUrl: 'https://api.example.com/v1' },
        { apiKey: 'sk-secret-3', authIndex: 'cfg_3' },
      ],
      claudeApiKeys: [{ apiKey: 'sk-secret-4', authIndex: 'cfg_4' }],
      openaiCompatibility: [
        {
          name: 'mockai',
          baseUrl: 'http://127.0.0.1:18400/v1',
          apiKeyEntries: [
            { apiKey: 'sk-secret-5', authIndex: 'oa_1' },
            { apiKey: 'sk-secret-6', authIndex: 'oa_2' },
          ],
        },
      ],
    } as unknown as Config;
    const labels = buildCredentialLabels(authFiles, config);
    expect(labels.get('idx_a')).toBe('alice@example.com');
    expect(labels.get('idx_b')).toBe('b.json');
    expect(labels.get('cfg_1')).toBe('codex · team #1');
    expect(labels.get('cfg_2')).toBe('codex · api.example.com #2');
    expect(labels.get('cfg_3')).toBe('codex #3');
    expect(labels.get('cfg_4')).toBe('claude');
    expect(labels.get('oa_1')).toBe('mockai #1');
    expect(labels.get('oa_2')).toBe('mockai #2');
    expect([...labels.values()].join(' ')).not.toContain('sk-secret');
  });

  test('tells apart credentials that share one email across teams', () => {
    const files = [
      {
        name: 'claude-1.json',
        email: 'sam@example.com',
        authIndex: 'idx_1',
        organizationName: 'Alpha',
      },
      {
        name: 'claude-2.json',
        email: 'sam@example.com',
        authIndex: 'idx_2',
        organizationName: 'Beta',
      },
      { name: 'claude-3.json', email: 'SAM@example.com', authIndex: 'idx_3_long_index' },
      {
        name: 'claude-4.json',
        email: 'kit@example.com',
        authIndex: 'idx_4',
        organizationName: 'Alpha',
      },
      {
        name: 'codex-a.json',
        email: 'lee@example.com',
        authIndex: 'idx_5',
        organizationName: 'Same',
      },
      {
        name: 'codex-b.json',
        email: 'lee@example.com',
        authIndex: 'idx_6',
        organizationName: 'Same',
      },
    ] as AuthFileItem[];
    const labels = buildCredentialLabels(files, null);
    expect(labels.get('idx_1')).toBe('sam@example.com · Alpha');
    expect(labels.get('idx_2')).toBe('sam@example.com · Beta');
    expect(labels.get('idx_3_long_index')).toBe('SAM@example.com · #idx_3_lo');
    // A unique email stays bare even when it carries an organization.
    expect(labels.get('idx_4')).toBe('kit@example.com');
    expect(labels.get('idx_5')).toBe('lee@example.com · Same · #idx_5');
    expect(labels.get('idx_6')).toBe('lee@example.com · Same · #idx_6');
  });

  test('derives reuse rate, quota reasons and exact TTL text', () => {
    const { counters } = normalizeRoutingObservability(rawSnapshot);
    expect(affinityReuseRate(counters)).toBe(90);
    expect(
      affinityReuseRate({ ...counters, affinityHits: 0, affinityNew: 0, affinityRebinds: 0 })
    ).toBeNull();
    expect(quotaReasonLabelKeys('weekly_pace,all_short_saturated')).toEqual([
      'dashboard.routing_quota_reason_weekly_pace',
      'dashboard.routing_quota_reason_all_short_saturated',
    ]);
    // Emitted when a credential without weekly data is probed so its quota gets observed.
    expect(quotaReasonLabelKeys('probe_no_weekly_data')).toEqual([
      'dashboard.routing_quota_reason_probe_no_weekly_data',
    ]);
    expect(quotaReasonLabelKeys('unknown_reason')).toEqual([]);
    expect(formatRoutingTtl(t, 3600)).toBe('1h');
    expect(formatRoutingTtl(t, 5400)).toBe('90m');
    expect(formatRoutingTtl(t, 45)).toBe('45s');
  });
});

describe('routing panel rendering', () => {
  const ready = (overrides: Record<string, unknown> = {}): RoutingObservabilityState => ({
    status: 'ready',
    data: normalizeRoutingObservability({ ...rawSnapshot, ...overrides }),
  });

  test('explains a failover that moved a session between credentials', () => {
    const markup = renderPanel(ready(), {
      config: { routingStrategy: 'quota-aware' } as Config,
    });
    expect(markup).toContain(t('dashboard.routing_strategy_quota_aware'));
    expect(markup).toContain(t('dashboard.routing_strategy_live'));
    expect(markup).toContain(t('dashboard.routing_affinity_on_ttl', { ttl: '1h' }));
    expect(markup).toContain('reuse 90%');
    expect(markup).toContain(t('dashboard.routing_selection_affinity_rebind'));
    expect(markup).toContain(t('dashboard.routing_attempt_failover', { attempt: 2 }));
    expect(markup).toContain('b.json');
    expect(markup).toContain(t('dashboard.routing_previous', { credential: 'alice@example.com' }));
    expect(markup).toContain(t('dashboard.routing_quota_reason_weekly_pace'));
    expect(markup).toContain(t('dashboard.routing_transport_websocket'));
    expect(markup).toContain('9c1e44d0');
    expect(markup).toContain(`>${t('dashboard.routing_col_session')}</th>`);
    expect(markup).toContain(
      t('dashboard.routing_transport_summary', { websocket: '40', http: '10' })
    );
    expect(markup).not.toContain('dashboard.routing_');
  });

  test('warns when the configured strategy is not what is running', () => {
    const markup = renderPanel(ready({ strategy: 'round-robin' }), {
      config: { routingStrategy: 'fastest' } as Config,
    });
    expect(markup).toContain(t('dashboard.routing_strategy_unrecognized', { value: 'fastest' }));
    expect(markup).toContain(t('dashboard.routing_strategy_round_robin'));
  });

  test('collapses long histories and hides optional columns without data', () => {
    const recent = Array.from({ length: 12 }, (_, index) => ({
      time: '2026-10-04T09:00:00Z',
      provider: 'claude',
      auth_index: `idx_${index}`,
      selection: 'strategy',
      attempt: 1,
      attempt_kind: 'initial',
    }));
    const markup = renderPanel(ready({ recent }));
    expect(markup.match(/<tr/g)?.length).toBe(1 + 8);
    expect(markup).toContain(t('dashboard.routing_recent_show_all', { value: 12 }));
    expect(markup).not.toContain(`>${t('dashboard.routing_col_transport')}</th>`);
    expect(markup).not.toContain(`>${t('dashboard.routing_col_session')}</th>`);
    // Without loaded config there is nothing to compare the live strategy against.
    expect(markup).not.toContain('running selector differs');
  });

  test('falls back to config and pool state when live data is unavailable', () => {
    const unsupported = renderPanel(
      { status: 'unsupported', data: null },
      { config: { routingStrategy: 'fill-first', routingSessionAffinity: true } as Config }
    );
    expect(unsupported).toContain(t('dashboard.routing_notice_unsupported'));
    expect(unsupported).toContain(t('dashboard.routing_strategy_fill_first'));
    expect(unsupported).toContain(t('dashboard.routing_strategy_configured'));
    expect(unsupported).toContain(t('dashboard.routing_affinity_pending'));
    expect(unsupported).toContain(t('dashboard.routing_failover_unavailable'));
    expect(unsupported).toContain(t('dashboard.routing_pool_value', { ready: 2, total: 2 }));
    expect(unsupported).not.toContain('<table');

    const home = renderPanel(ready({ mode: 'home' }));
    expect(home).toContain(t('dashboard.routing_notice_home'));
    expect(home).not.toContain('<table');
  });
});

describe('routing panel refresh', () => {
  const refreshButton = /<button[^>]*aria-label="Refresh credential selection"[^>]*>/;
  const onRefresh = async () => undefined;

  test('offers a scoped refresh and shows when the snapshot was observed', () => {
    const markup = renderPanel(
      { status: 'ready', data: normalizeRoutingObservability(rawSnapshot) },
      { onRefresh }
    );
    const button = markup.match(refreshButton)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('aria-busy="false"');
    expect(button).not.toContain('disabled');
    expect(button).toContain(`title="${t('dashboard.routing_refresh_hint')}"`);
    const observed = new Date(Date.parse('2026-10-04T10:00:00Z')).toLocaleTimeString('en', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    expect(markup).toContain(t('dashboard.routing_updated_at', { time: observed }));
  });

  test('keeps the refresh available when live data is missing', () => {
    // The pool card still reloads from auth files, and an upgraded backend may now answer.
    const markup = renderPanel({ status: 'unsupported', data: null }, { onRefresh });
    expect(markup).toMatch(refreshButton);
    expect(markup).not.toContain('Updated ');
  });

  test('hides the button when no refresh handler is provided', () => {
    const markup = renderPanel({ status: 'unsupported', data: null });
    expect(markup).not.toMatch(refreshButton);
  });

  test('the dashboard reloads routing and auth files without a full refresh', async () => {
    const source = await Bun.file(
      new URL('../src/features/dashboard/hooks/useDashboardOverview.ts', import.meta.url)
    ).text();
    const scoped = source.slice(source.indexOf('const refreshRoutingPanel'));
    expect(scoped).toContain('Promise.allSettled([refreshRouting(), loadAuthFiles()])');
  });
});

describe('routing locale coverage', () => {
  test('every routing label exists in all four languages', () => {
    const keys = Object.keys(en.dashboard).filter((key) => key.startsWith('routing_'));
    expect(keys.length).toBeGreaterThanOrEqual(60);
    for (const locale of [zhCN, zhTW, ru]) {
      const dashboard = locale.dashboard as Record<string, string>;
      for (const key of keys) {
        expect(dashboard[key]?.trim()).toBeTruthy();
      }
    }
  });
});
