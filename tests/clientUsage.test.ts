import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import {
  clientUsageApi,
  isClientUsageUnsupported,
  normalizeClientUsage,
} from '@/services/api/clientUsage';
import { apiKeyNameFingerprint } from '@/features/config/apiKeyNames';
import { ClientUsagePanel } from '@/features/dashboard/components/ClientUsagePanel';
import type { ClientUsageState } from '@/features/dashboard/hooks/useClientUsage';
import {
  ANONYMOUS_CLIENT_KEY_ID,
  buildClientUsageRows,
  buildLocalKeyNames,
  claudePlanLabel,
  clientKeyId,
  clientKeyLabel,
  clientUsageHints,
  clientUsageToday,
  formatLimitFraction,
  formatPlanAllowance,
  formatProUnits,
  summarizeRecentDays,
  titleCasePlan,
  topModels,
} from '@/features/dashboard/clientUsage';
import type { ClientKeyUsage, ClientUsageDay } from '@/types/clientUsage';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  // Mirrors the app config: React escapes rendered text.
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

// Obviously fake fixture keys; ids are derived the way the backend derives them.
const LAPTOP_KEY = 'fixture-key-laptop';
const PHONE_KEY = 'fixture-key-phone';
const DESKTOP_KEY = 'fixture-key-desktop';
const LAPTOP_ID = clientKeyId(LAPTOP_KEY);
const PHONE_ID = clientKeyId(PHONE_KEY);
const DESKTOP_ID = clientKeyId(DESKTOP_KEY);
const REMOVED_ID = 'c0ffee00c0ffee00';
const API_BASE = 'http://127.0.0.1:18920';

const NOW = Date.parse('2026-10-07T12:00:00Z');

const tokens = (total: number) => ({ total_tokens: total });

const rawSnapshot = {
  // Go encodes the server's own UTC offset, so the date part is the server-local date.
  generated_at: '2026-10-07T23:00:00.123456789+11:00',
  since: '2026-10-01T08:00:00Z',
  keys: [
    {
      id: LAPTOP_ID,
      key: 'fixt...ptop',
      configured: true,
      first_used_at: '2026-10-01T08:05:00Z',
      last_used_at: '2026-10-07T11:55:00Z',
      totals: {
        requests: 160,
        failed: 3,
        tokens: {
          input_tokens: 3_000_000,
          output_tokens: 500_000,
          reasoning_tokens: 40_000,
          cache_read_tokens: 2_000_000,
          cache_write_tokens: 100_000,
          total_tokens: 3_500_000,
        },
      },
      models: {
        'claude-sonnet-4-5': { requests: 120, failed: 2, tokens: tokens(2_800_000) },
        'gpt-5': { requests: 20, failed: 0, tokens: tokens(400_000) },
        'claude-haiku-4-5': { requests: 15, failed: 1, tokens: tokens(250_000) },
        'gemini-2.5-pro': { requests: 5, failed: 0, tokens: tokens(50_000) },
        '  ': { requests: 1, tokens: tokens(1) },
        broken: 'not counters',
      },
      daily: [
        { date: '2026-10-07', requests: 10, failed: 1, tokens: tokens(500_000) },
        { date: '2026-09-30', requests: 100, failed: 0, tokens: tokens(1_000_000) },
        { date: '2026-10-01', requests: 50, failed: 2, tokens: tokens(2_000_000) },
        { date: 'yesterday', requests: 999 },
        null,
      ],
      claude: {
        current_pro_units: 0.84,
        total_pro_units: 2.31,
        credentials: [
          {
            auth_id: 'claude-personal.json',
            auth_index: 'idx_personal',
            label: 'Personal',
            plan: 'max_5x',
            plan_pro_units: 2,
            plan_source: 'rate_limit_tier',
            window_resets_at: '2026-10-09T15:00:00Z',
            current_fraction: 0.42,
            current_pro_units: 0.84,
            total_fraction: 1.155,
            total_pro_units: 2.31,
          },
          { label: 'missing auth id', current_pro_units: 5 },
        ],
      },
    },
    {
      id: PHONE_ID,
      name: 'Phone',
      key: 'fixt...hone',
      configured: true,
      last_used_at: '2026-10-06T20:00:00Z',
      totals: { requests: 40, failed: 0, tokens: tokens(3_000_000) },
      models: { 'claude-sonnet-4-5': { requests: 40, failed: 0, tokens: tokens(3_000_000) } },
      daily: [{ date: '2026-10-06', requests: 40, failed: 0, tokens: tokens(3_000_000) }],
      claude: {
        current_pro_units: 0.28,
        total_pro_units: 0.28,
        credentials: [
          {
            auth_id: 'claude-team.json',
            label: 'ANU Team',
            plan: 'team',
            plan_pro_units: 1.25,
            plan_source: 'organization_type',
            window_resets_at: '2026-10-10T00:00:00Z',
            current_fraction: 0.224,
            current_pro_units: 0.28,
            total_fraction: 0.224,
            total_pro_units: 0.28,
          },
        ],
      },
    },
    {
      id: DESKTOP_ID,
      key: 'fixt...ktop',
      configured: true,
      totals: { requests: 0, failed: 0, tokens: {} },
    },
    {
      id: REMOVED_ID,
      configured: false,
      first_used_at: '0001-01-01T00:00:00Z',
      last_used_at: '2026-09-20T10:00:00Z',
      totals: { requests: 7, failed: -2, tokens: tokens(7000) },
      daily: [{ date: '2026-09-20', requests: 7, tokens: tokens(7000) }],
    },
    { id: PHONE_ID, name: 'Duplicate id' },
    { name: 'No id' },
    'garbage',
  ],
  claude_credentials: [
    {
      auth_id: 'claude-personal.json',
      auth_index: 'idx_personal',
      label: 'Personal',
      plan: 'max_5x',
      plan_pro_units: 2,
      plan_source: 'rate_limit_tier',
      weekly_utilization: 0.61,
      window_resets_at: '2026-10-09T15:00:00Z',
      observed_at: '2026-10-07T11:59:00Z',
      unattributed_current_fraction: 0.03,
      unattributed_total_fraction: 0.05,
    },
    {
      auth_id: 'claude-corp.json',
      label: 'Corp',
      plan: 'enterprise',
      plan_pro_units: 3,
      plan_source: 'weight',
      weekly_utilization: 0,
      observed_at: '2026-09-28T09:00:00Z',
      unattributed_current_fraction: 0,
      unattributed_total_fraction: 0.2,
    },
    { plan: 'pro', weekly_utilization: 0.5 },
    {
      auth_id: 'claude-odd.json',
      plan: '',
      plan_pro_units: -1,
      weekly_utilization: 7,
      unattributed_current_fraction: 'lots',
    },
  ],
};

const snapshot = normalizeClientUsage(rawSnapshot);
const localNames = buildLocalKeyNames(API_BASE, [LAPTOP_KEY, PHONE_KEY, DESKTOP_KEY], {
  [apiKeyNameFingerprint(API_BASE, LAPTOP_KEY)]: ' MacBook ',
  [apiKeyNameFingerprint(API_BASE, PHONE_KEY)]: 'Local phone name',
});
const anonymousLabel = t('dashboard.client_usage_anonymous');

const noTokens = (total = 0) => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
});

const day = (date: string, requests: number, total: number, failed = 0): ClientUsageDay => ({
  date,
  requests,
  failed,
  tokens: noTokens(total),
});

const key = (overrides: Partial<ClientKeyUsage> & { id: string }): ClientKeyUsage => ({
  configured: true,
  firstUsedAtMs: null,
  lastUsedAtMs: null,
  totals: { requests: 0, failed: 0, tokens: noTokens() },
  models: [],
  daily: [],
  claude: null,
  ...overrides,
});

const used = (id: string, configured = true): ClientKeyUsage =>
  key({ id, configured, lastUsedAtMs: NOW - 60_000 });

const renderPanel = (usage: ClientUsageState, onRefresh?: () => Promise<void>) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        null,
        createElement(ClientUsagePanel, { usage, localNames, onRefresh, nowMs: NOW })
      )
    )
  );

/** React escapes apostrophes in rendered text and attributes. */
const html = (text: string) => text.replace(/'/g, '&#x27;');

const ready = (raw: unknown): ClientUsageState => ({
  status: 'ready',
  data: normalizeClientUsage(raw),
});

describe('client usage API', () => {
  test('reads the v8 route and normalizes snake_case fields', async () => {
    const get = spyOn(apiClient, 'get').mockResolvedValue(rawSnapshot);
    try {
      const result = await clientUsageApi.get();
      expect(get).toHaveBeenCalledWith('/observability/usage/clients', { timeout: 15000 });
      expect(result.generatedAtMs).toBe(Date.parse('2026-10-07T12:00:00.123Z'));
      expect(result.serverDate).toBe('2026-10-07');
      expect(result.sinceMs).toBe(Date.parse('2026-10-01T08:00:00Z'));
      const laptop = result.keys[0];
      expect(laptop).toMatchObject({
        id: LAPTOP_ID,
        key: 'fixt...ptop',
        configured: true,
        firstUsedAtMs: Date.parse('2026-10-01T08:05:00Z'),
        lastUsedAtMs: Date.parse('2026-10-07T11:55:00Z'),
      });
      expect(laptop.name).toBeUndefined();
      expect(laptop.totals).toEqual({
        requests: 160,
        failed: 3,
        tokens: {
          input: 3_000_000,
          output: 500_000,
          reasoning: 40_000,
          cacheRead: 2_000_000,
          cacheWrite: 100_000,
          total: 3_500_000,
        },
      });
      expect(laptop.claude?.credentials).toEqual([
        {
          authId: 'claude-personal.json',
          authIndex: 'idx_personal',
          label: 'Personal',
          plan: 'max_5x',
          planProUnits: 2,
          planSource: 'rate_limit_tier',
          windowResetsAtMs: Date.parse('2026-10-09T15:00:00Z'),
          currentFraction: 0.42,
          currentProUnits: 0.84,
          totalFraction: 1.155,
          totalProUnits: 2.31,
        },
      ]);
      expect(result.claudeCredentials[0]).toEqual({
        authId: 'claude-personal.json',
        authIndex: 'idx_personal',
        label: 'Personal',
        plan: 'max_5x',
        planProUnits: 2,
        planSource: 'rate_limit_tier',
        weeklyUtilization: 0.61,
        windowResetsAtMs: Date.parse('2026-10-09T15:00:00Z'),
        observedAtMs: Date.parse('2026-10-07T11:59:00Z'),
        unattributedCurrentFraction: 0.03,
        unattributedTotalFraction: 0.05,
      });
    } finally {
      get.mockRestore();
    }
  });

  test('drops or defaults malformed entries instead of throwing', () => {
    // Entries without an id, non-objects and duplicate ids are dropped.
    expect(snapshot.keys.map((entry) => entry.id)).toEqual([
      LAPTOP_ID,
      PHONE_ID,
      DESKTOP_ID,
      REMOVED_ID,
    ]);
    expect(snapshot.keys[1].name).toBe('Phone');
    const laptop = snapshot.keys[0];
    expect(laptop.daily.map((day) => day.date)).toEqual(['2026-09-30', '2026-10-01', '2026-10-07']);
    expect(laptop.models.map((model) => model.model)).toEqual([
      'claude-sonnet-4-5',
      'gpt-5',
      'claude-haiku-4-5',
      'gemini-2.5-pro',
    ]);
    const removed = snapshot.keys[3];
    expect(removed.firstUsedAtMs).toBeNull();
    expect(removed.totals.failed).toBe(0);
    expect(removed.claude).toBeNull();
    expect(removed.models).toEqual([]);
    expect(snapshot.keys[2].totals.tokens.total).toBe(0);

    expect(snapshot.claudeCredentials.map((entry) => entry.authId)).toEqual([
      'claude-personal.json',
      'claude-corp.json',
      'claude-odd.json',
    ]);
    expect(snapshot.claudeCredentials[1].windowResetsAtMs).toBeNull();
    expect(snapshot.claudeCredentials[2]).toMatchObject({
      plan: 'unknown',
      planProUnits: 1,
      planSource: '',
      weeklyUtilization: 1,
      unattributedCurrentFraction: 0,
    });

    for (const raw of ['nope', null, 42, [], { keys: 'x', claude_credentials: {} }]) {
      const empty = normalizeClientUsage(raw);
      expect(empty.keys).toEqual([]);
      expect(empty.claudeCredentials).toEqual([]);
      expect(empty.generatedAtMs).toBeNull();
      expect(empty.serverDate).toBeNull();
    }
    expect(normalizeClientUsage({ generated_at: '2026-10-07T01:00:00Z' }).serverDate).toBe(
      '2026-10-07'
    );
    expect(normalizeClientUsage({ generated_at: 'not a time' }).serverDate).toBeNull();
  });

  test('tells a missing endpoint apart from other failures', () => {
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    expect(isClientUsageUnsupported(notFound)).toBe(true);
    expect(isClientUsageUnsupported({ status: 500 })).toBe(false);
    expect(isClientUsageUnsupported(new Error('network'))).toBe(false);
    expect(isClientUsageUnsupported(null)).toBe(false);
    expect(isClientUsageUnsupported('404')).toBe(false);
  });
});

describe('client key ids', () => {
  const nodeKeyId = (value: string) =>
    createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);

  test('match the backend SHA-256 prefix', () => {
    for (const value of [LAPTOP_KEY, PHONE_KEY, DESKTOP_KEY, 'fixture-ключ-π', 'x']) {
      expect(clientKeyId(value)).toBe(nodeKeyId(value));
      expect(clientKeyId(value)).toMatch(/^[0-9a-f]{16}$/);
    }
    // Reference value from the backend's KeyID for the demo laptop key.
    expect(clientKeyId('demo-laptop-key-0001')).toBe('195aedb71f772359');
  });

  test('trim like Go strings.TrimSpace', () => {
    expect(clientKeyId(`  ${LAPTOP_KEY}\t\n`)).toBe(LAPTOP_ID);
    // Go trims NEL and ideographic spaces but keeps a byte order mark.
    expect(clientKeyId(`\u0085${LAPTOP_KEY}\u3000`)).toBe(LAPTOP_ID);
    expect(clientKeyId(`\ufeff${LAPTOP_KEY}`)).toBe(nodeKeyId(`\ufeff${LAPTOP_KEY}`));
    expect(clientKeyId('')).toBe(ANONYMOUS_CLIENT_KEY_ID);
    expect(clientKeyId(' \t ')).toBe(ANONYMOUS_CLIENT_KEY_ID);
  });
});

describe('client usage logic', () => {
  test('names keys by backend name, then local name, then masked key, then id', () => {
    expect(localNames.get(LAPTOP_ID)).toBe('MacBook');
    expect(localNames.has(DESKTOP_ID)).toBe(false);
    // A name saved for another server does not apply.
    expect(
      buildLocalKeyNames('https://other.test', [LAPTOP_KEY], {
        [apiKeyNameFingerprint(API_BASE, LAPTOP_KEY)]: 'MacBook',
      }).size
    ).toBe(0);

    const label = (entry: Partial<ClientKeyUsage> & { id: string }) =>
      clientKeyLabel(key(entry), localNames, anonymousLabel);
    expect(label({ id: PHONE_ID, name: 'Phone', key: 'fixt...hone' })).toEqual({
      text: 'Phone',
      source: 'config',
    });
    expect(label({ id: LAPTOP_ID, key: 'fixt...ptop' })).toEqual({
      text: 'MacBook',
      source: 'local',
    });
    expect(label({ id: DESKTOP_ID, key: 'fixt...ktop' })).toEqual({
      text: 'fixt...ktop',
      source: 'key',
    });
    expect(label({ id: REMOVED_ID })).toEqual({ text: REMOVED_ID, source: 'id' });
    expect(label({ id: ANONYMOUS_CLIENT_KEY_ID })).toEqual({
      text: 'Requests without an API key',
      source: 'anonymous',
    });
  });

  test('sums the last seven server-local days', () => {
    const daily = [
      day('2026-09-26', 1000, 1000),
      day('2026-09-27', 1, 10, 1),
      day('2026-09-30', 2, 20),
      day('2026-10-03', 4, 40, 2),
      day('2026-10-04', 8000, 8000),
    ];
    // The window crosses a month boundary and excludes days after "today".
    expect(summarizeRecentDays(daily, '2026-10-03')).toEqual({
      requests: 7,
      failed: 3,
      tokens: 70,
    });
    expect(summarizeRecentDays([], '2026-10-03')).toEqual({ requests: 0, failed: 0, tokens: 0 });
    expect(clientUsageToday(snapshot, NOW)).toBe('2026-10-07');
    expect(clientUsageToday({ ...snapshot, serverDate: null, generatedAtMs: null }, NOW)).toMatch(
      /^2026-10-0[78]$/
    );
  });

  test('sorts by Claude usage, then 7-day tokens and name, with unused keys last', () => {
    const rows = buildClientUsageRows(snapshot.keys, {
      localNames,
      anonymousLabel,
      today: '2026-10-07',
    });
    expect(rows.map((row) => row.label.text)).toEqual([
      'MacBook',
      'Phone',
      REMOVED_ID,
      'fixt...ktop',
    ]);
    const [laptop, phone, removed, desktop] = rows;
    expect(laptop.secondary).toBe('fixt...ptop');
    expect(laptop.week).toEqual({ requests: 60, failed: 3, tokens: 2_500_000 });
    expect(laptop.claudeShare).toBeCloseTo(0.75, 10);
    expect(phone.claudeShare).toBeCloseTo(0.25, 10);
    expect(removed).toMatchObject({
      configured: false,
      used: true,
      claudeCurrentProUnits: null,
      claudeShare: null,
      week: { requests: 0, failed: 0, tokens: 0 },
    });
    expect(desktop).toMatchObject({ used: false, secondary: undefined, claudeShare: null });
    expect(laptop.topModels.map((model) => model.model)).toEqual([
      'claude-sonnet-4-5',
      'gpt-5',
      'claude-haiku-4-5',
    ]);

    const tie = buildClientUsageRows(
      [
        key({ id: 'b', name: 'Beta', lastUsedAtMs: NOW, daily: [] }),
        key({
          id: 'a',
          name: 'Alpha',
          lastUsedAtMs: NOW,
          daily: [day('2026-10-07', 3, 3000)],
        }),
        key({ id: 'c', name: 'Gamma', lastUsedAtMs: NOW }),
        key({ id: 'z', name: 'Aardvark' }),
      ],
      { localNames, anonymousLabel, today: '2026-10-07' }
    );
    expect(tie.map((row) => row.label.text)).toEqual(['Alpha', 'Beta', 'Gamma', 'Aardvark']);
    expect(tie.every((row) => row.claudeShare === null)).toBe(true);
    expect(topModels([])).toEqual([]);

    // Each row lists its heaviest Claude credential first.
    const [multi] = buildClientUsageRows(
      normalizeClientUsage({
        keys: [
          {
            id: 'k',
            configured: true,
            last_used_at: '2026-10-07T11:00:00Z',
            claude: {
              current_pro_units: 1,
              credentials: [
                { auth_id: 'a.json', label: 'Small', current_pro_units: 0.1 },
                { auth_id: 'b.json', label: 'Large', current_pro_units: 0.9 },
              ],
            },
          },
        ],
      }).keys,
      { localNames, anonymousLabel, today: '2026-10-07' }
    );
    expect(multi.claudeCredentials.map((credential) => credential.label)).toEqual([
      'Large',
      'Small',
    ]);
  });

  test('nudges toward one key per device', () => {
    expect(clientUsageHints(snapshot.keys)).toEqual([{ kind: 'removed-keys', count: 1 }]);
    expect(clientUsageHints([used(ANONYMOUS_CLIENT_KEY_ID, false)])).toEqual([{ kind: 'no-keys' }]);
    expect(clientUsageHints([key({ id: ANONYMOUS_CLIENT_KEY_ID, configured: false })])).toEqual([]);
    expect(clientUsageHints([used(LAPTOP_ID)])).toEqual([{ kind: 'shared-key' }]);
    expect(clientUsageHints([key({ id: LAPTOP_ID })])).toEqual([]);
    // Old anonymous usage is not a removed key.
    expect(clientUsageHints([used(LAPTOP_ID), used(ANONYMOUS_CLIENT_KEY_ID, false)])).toEqual([
      { kind: 'shared-key' },
    ]);
    expect(clientUsageHints([used(LAPTOP_ID), used(PHONE_ID)])).toEqual([]);
    expect(
      clientUsageHints([used(REMOVED_ID, false), used(ANONYMOUS_CLIENT_KEY_ID, false)])
    ).toEqual([{ kind: 'no-keys' }, { kind: 'removed-keys', count: 1 }]);
  });

  test('labels plans and formats Pro units', () => {
    expect(claudePlanLabel(t, 'pro', 'plan_type')).toBe('Pro');
    expect(claudePlanLabel(t, 'team', 'organization_type')).toBe('Team');
    expect(claudePlanLabel(t, 'max_5x', 'rate_limit_tier')).toBe('Max 5x');
    expect(claudePlanLabel(t, 'max_20x', 'plan_type')).toBe('Max 20x');
    expect(claudePlanLabel(t, 'unknown', 'weight')).toBe('Unknown plan (by weight)');
    expect(claudePlanLabel(t, 'enterprise', 'weight')).toBe('Enterprise (by weight)');
    expect(titleCasePlan('claude_edu-plus')).toBe('Claude Edu Plus');
    expect(formatProUnits(0.84, 'en')).toBe('0.84');
    expect(formatProUnits(2, 'en')).toBe('2.00');
    expect(formatProUnits(12.345, 'en')).toBe('12.3');
    expect(formatProUnits(0.5, 'ru')).toBe('0,50');
    expect(formatPlanAllowance(1.25, 'en')).toBe('1.25');
    expect(formatPlanAllowance(10, 'en')).toBe('10');
    expect(formatLimitFraction(0.42)).toBe('42%');
    expect(formatLimitFraction(0.034)).toBe('3.4%');
    expect(formatLimitFraction(0.0004)).toBe('<0.1%');
    expect(formatLimitFraction(0)).toBe('0%');
  });
});

describe('client usage panel rendering', () => {
  const refreshButton = /<button[^>]*aria-label="Refresh usage by API key"[^>]*>/;
  const onRefresh = async () => undefined;

  test('shows each key, its Claude share and the credential strip', () => {
    const markup = renderPanel({ status: 'ready', data: snapshot }, onRefresh);
    expect(markup).toContain(
      t('dashboard.client_usage_since', {
        date: new Date(Date.parse('2026-10-01T08:00:00Z')).toLocaleDateString('en', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }),
      })
    );
    expect(markup).toMatch(refreshButton);
    // Display names with the masked key underneath.
    expect(markup).toContain('>MacBook</span>');
    expect(markup).toContain('>Phone</span>');
    expect(markup).toContain('fixt...ptop');
    expect(markup).toContain(t('dashboard.client_usage_not_in_config'));
    // Claude this week, share, 7-day totals and last use.
    expect(markup).toContain('0.84 Pro');
    expect(markup).toContain('<span aria-hidden="true">75%</span>');
    expect(markup).toContain(html(t('dashboard.client_usage_share_label', { value: '75%' })));
    expect(markup).toContain('style="width:75%"');
    expect(markup).toContain('2.5M');
    expect(markup).toContain(t('dashboard.client_usage_failed', { value: '3' }));
    expect(markup).toContain('5 minutes ago');
    expect(markup).toContain(t('dashboard.client_usage_unused'));
    // Per-credential breakdown and top models.
    expect(markup).toContain('Personal · Max 5x · 42% of weekly limit · 0.84 Pro');
    expect(markup).toContain('ANU Team · Team · 22% of weekly limit · 0.28 Pro');
    expect(markup).toContain(t('dashboard.client_usage_claude_total', { value: '2.31 Pro' }));
    expect(markup).toContain('claude-haiku-4-5');
    expect(markup).not.toContain('gemini-2.5-pro');
    // Credential strip.
    expect(markup).toContain('Max 5x · 2 Pro / week');
    expect(markup).toContain('aria-valuenow="61"');
    expect(markup).toContain('61% of weekly limit used · ');
    expect(markup).toContain('resets in 2 days');
    expect(markup).toContain(html(t('dashboard.client_usage_unattributed', { value: '3%' })));
    expect(markup).toContain('Enterprise (by weight) · 3 Pro / week');
    expect(markup).toContain(t('dashboard.client_usage_window_closed'));
    expect(markup).toContain(html(t('dashboard.client_usage_footnote')));
    expect(markup).toContain('href="/config?field=apiKeys"');
    // Usage from a removed key is flagged, without the one-key nudges.
    expect(markup).toContain(t('dashboard.client_usage_hint_removed_keys', { count: 1 }));
    expect(markup).not.toContain(t('dashboard.client_usage_hint_shared_key'));
    expect(markup).not.toContain('dashboard.client_usage_');
    expect(markup).not.toContain('claude_quota.');
  });

  test('asks for one key per device when all devices share one', () => {
    const markup = renderPanel(
      ready({
        generated_at: '2026-10-07T12:00:00Z',
        keys: [
          {
            id: LAPTOP_ID,
            key: 'fixt...ptop',
            configured: true,
            last_used_at: '2026-10-07T11:00:00Z',
            totals: { requests: 5, failed: 0, tokens: tokens(5000) },
            daily: [{ date: '2026-10-07', requests: 5, failed: 0, tokens: tokens(5000) }],
          },
        ],
        claude_credentials: [],
      })
    );
    expect(markup).toContain(t('dashboard.client_usage_hint_shared_key'));
    expect(markup).toContain(`>${t('dashboard.client_usage_hint_link')}</a>`);
    expect(markup).toContain('>MacBook</span>');
    expect(markup).not.toContain(t('dashboard.client_usage_credentials_title'));
    expect(markup).not.toContain(t('dashboard.client_usage_empty'));
    expect(markup).not.toMatch(refreshButton);
  });

  test('explains requests without any API key', () => {
    const markup = renderPanel(
      ready({
        keys: [
          {
            id: 'anonymous',
            configured: false,
            last_used_at: '2026-10-07T11:00:00Z',
            totals: { requests: 2, tokens: tokens(100) },
          },
        ],
      })
    );
    expect(markup).toContain(t('dashboard.client_usage_hint_no_keys'));
    expect(markup).toContain(t('dashboard.client_usage_anonymous'));
    expect(markup).not.toContain(t('dashboard.client_usage_not_in_config'));
  });

  test('notes an outdated backend without listing anything', () => {
    const markup = renderPanel({ status: 'unsupported', data: null }, onRefresh);
    expect(markup).toContain(t('dashboard.client_usage_unsupported'));
    // An upgraded backend may answer after a manual refresh.
    expect(markup).toMatch(refreshButton);
    expect(markup).not.toContain('<ul');
    expect(markup).not.toContain(t('dashboard.client_usage_since', { date: '' }).trim());
  });

  test('covers loading, error and empty states', () => {
    expect(renderPanel({ status: 'loading', data: null })).toContain(
      t('dashboard.client_usage_loading')
    );
    expect(renderPanel({ status: 'error', data: null })).toContain(
      t('dashboard.client_usage_error')
    );
    const empty = renderPanel(ready({ generated_at: '2026-10-07T12:00:00Z', keys: [] }));
    expect(empty).toContain(t('dashboard.client_usage_empty'));
    expect(empty).not.toContain(t('dashboard.client_usage_loading'));
  });

  test('the full dashboard refresh reloads usage by API key', async () => {
    const source = await Bun.file(
      new URL('../src/features/dashboard/hooks/useDashboardOverview.ts', import.meta.url)
    ).text();
    const refresh = source.slice(source.indexOf('const refresh = useCallback'));
    expect(refresh.slice(0, refresh.indexOf('}, ['))).toContain('refreshClientUsage()');
  });
});

describe('client usage locale coverage', () => {
  test('every label exists in all four languages with the same placeholders', () => {
    const placeholders = (value: string) => (value.match(/{{\s*\w+\s*}}/g) ?? []).sort();
    const keys = Object.keys(en.dashboard).filter((name) => name.startsWith('client_usage_'));
    expect(keys.length).toBeGreaterThanOrEqual(40);
    const english = en.dashboard as Record<string, string>;
    for (const locale of [zhCN, zhTW, ru]) {
      const dashboard = locale.dashboard as Record<string, string>;
      for (const name of keys) {
        expect(dashboard[name]?.trim()).toBeTruthy();
        expect(placeholders(dashboard[name])).toEqual(placeholders(english[name]));
      }
    }
  });
});
