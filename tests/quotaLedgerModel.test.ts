/**
 * Ledger model: per-provider window extraction and the provider rollup that
 * feeds the summary strip.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import i18n from '@/i18n';
import {
  buildLedgerColumns,
  orderLedgerWindows,
  summarizeProvider,
  type LedgerSnapshot,
  type LedgerWindow,
} from '@/features/quota/ledgerModel';
import { buildClaudeLedger } from '@/features/quota/providers/claude/ledger';
import { buildCodexLedger } from '@/features/quota/providers/codex/ledger';
import { buildXaiLedger } from '@/features/quota/providers/xai/ledger';
import { buildAntigravityLedger } from '@/features/quota/providers/antigravity/ledger';
import { QUOTA_ADAPTERS } from '@/features/quota/providers';
import { QUOTA_TAB_ORDER } from '@/features/quota/constants';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  XaiBillingSummary,
  XaiQuotaState,
} from '@/types';

const NOW = new Date(2026, 8, 10, 12).getTime();

const win = (overrides: Partial<LedgerWindow> & { id: string }): LedgerWindow => ({
  label: overrides.id,
  remaining: null,
  resetAtMs: null,
  resetLabel: null,
  periodHours: null,
  ...overrides,
});

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('orderLedgerWindows', () => {
  test('moves preferred ids first and keeps the rest in incoming order', () => {
    const ordered = orderLedgerWindows(
      [{ id: 'a' }, { id: 'five-hour' }, { id: 'b' }, { id: 'weekly' }],
      ['weekly', 'five-hour']
    );
    expect(ordered.map((window) => window.id)).toEqual(['weekly', 'five-hour', 'a', 'b']);
  });
});

describe('buildLedgerColumns', () => {
  test('unions window ids in first-seen order and skips unloaded rows', () => {
    const columns = buildLedgerColumns([
      { plan: null, windows: [win({ id: 'weekly' }), win({ id: 'five-hour' })] },
      null,
      { plan: null, windows: [win({ id: 'model' }), win({ id: 'weekly' })] },
    ]);
    expect(columns.map((column) => column.id)).toEqual(['weekly', 'five-hour', 'model']);
  });
});

describe('summarizeProvider', () => {
  const snapshots: (LedgerSnapshot | null)[] = [
    {
      plan: 'Max',
      windows: [
        win({ id: 'fable', remaining: 58, resetAtMs: NOW + DAY_MS, periodHours: 168 }),
        win({ id: 'five-hour', remaining: 100, periodHours: 5 }),
        win({ id: 'seven-day', remaining: 79, resetAtMs: NOW + DAY_MS, periodHours: 168 }),
      ],
    },
    {
      plan: 'Max',
      windows: [
        // A reset already in the past must not be reported as the next one.
        win({ id: 'fable', remaining: 51, resetAtMs: NOW - HOUR_MS, periodHours: 168 }),
        win({ id: 'five-hour', remaining: 99, resetAtMs: NOW + 3 * HOUR_MS, periodHours: 5 }),
        win({ id: 'seven-day', remaining: 75, resetAtMs: NOW + 2 * DAY_MS, periodHours: 168 }),
      ],
    },
    null,
  ];

  test('pools the headline window against 100% per credential, loaded or not', () => {
    const summary = summarizeProvider(snapshots, NOW);
    expect(summary.credentialCount).toBe(3);
    expect(summary.loadedCount).toBe(2);
    expect(summary.headline?.id).toBe('fable');
    expect(summary.headline?.totalRemaining).toBe(109);
    expect(summary.headline?.capacity).toBe(300);
    expect(summary.headline?.segments).toEqual([58, 51, null]);
    expect(summary.headline?.nextResetMs).toBe(NOW + DAY_MS);
  });

  test('orders secondary lines longest window first', () => {
    const summary = summarizeProvider(snapshots, NOW);
    expect(summary.secondary.map((line) => line.id)).toEqual(['seven-day', 'five-hour']);
    expect(summary.secondary[0].totalRemaining).toBe(154);
  });

  test('a window only some accounts carry is pooled over those accounts and not headlined', () => {
    const withFable: LedgerSnapshot = {
      plan: 'Max',
      windows: [
        win({ id: 'fable', remaining: 100, periodHours: 168 }),
        win({ id: 'seven-day', remaining: 90, periodHours: 168 }),
      ],
    };
    const withoutFable: LedgerSnapshot = {
      plan: 'Max',
      windows: [win({ id: 'seven-day', remaining: 40, periodHours: 168 })],
    };
    const summary = summarizeProvider([withFable, withoutFable, withoutFable, null], NOW);
    expect(summary.headline?.id).toBe('seven-day');
    expect(summary.headline?.totalRemaining).toBe(170);
    expect(summary.headline?.capacity).toBe(400);
    const fable = summary.secondary.find((line) => line.id === 'fable');
    // The account that has it plus the one not loaded yet; loaded accounts without it are out.
    expect(fable?.capacity).toBe(200);
    expect(fable?.segments).toEqual([100, null]);
    expect(fable?.coverage).toBe(1);
  });

  test('reports no headline when nothing is loaded', () => {
    const summary = summarizeProvider([null, null], NOW);
    expect(summary.headline).toBeNull();
    expect(summary.secondary).toEqual([]);
    expect(summary.loadedCount).toBe(0);
  });

  test('leaves the total unknown when no credential reports a figure', () => {
    const summary = summarizeProvider(
      [{ plan: null, windows: [win({ id: 'weekly', remaining: null })] }],
      NOW
    );
    expect(summary.headline?.totalRemaining).toBeNull();
    expect(summary.headline?.segments).toEqual([null]);
  });
});

describe('provider ledger extractors', () => {
  test('every quota provider registers a ledger extractor', () => {
    for (const type of QUOTA_TAB_ORDER) {
      expect(typeof QUOTA_ADAPTERS[type].ledger).toBe('function');
    }
  });

  test('Claude leads with the model-scoped weekly limit and reads percent remaining', () => {
    const quota: ClaudeQuotaState = {
      status: 'success',
      planType: 'plan_max',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'claude_quota.five_hour',
          usedPercent: 0,
          resetLabel: '-',
          resetAtMs: null,
          periodHours: 5,
        },
        {
          id: 'seven-day',
          label: '7-day limit',
          labelKey: 'claude_quota.seven_day',
          usedPercent: 21,
          resetLabel: '-',
          resetAtMs: NOW + DAY_MS,
          periodHours: 168,
        },
        {
          id: 'seven-day-fable',
          label: '7-day Fable',
          labelKey: 'claude_quota.seven_day_fable',
          usedPercent: 42,
          resetLabel: '-',
          resetAtMs: NOW + DAY_MS,
          periodHours: 168,
        },
      ],
    };
    const ledger = buildClaudeLedger(quota, i18n.t);
    expect(ledger.plan).toBe('Max');
    expect(ledger.windows.map((window) => window.id)).toEqual([
      'seven-day-fable',
      'seven-day',
      'five-hour',
    ]);
    expect(ledger.windows.map((window) => window.remaining)).toEqual([58, 79, 100]);
    expect(ledger.windows[2].resetAtMs).toBeNull();
  });

  test('Claude accounts without a Fable limit lead with the 7-day limit and get no Fable column', () => {
    const quota: ClaudeQuotaState = {
      status: 'success',
      planType: 'plan_max',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 10,
          resetLabel: '-',
          resetAtMs: null,
          periodHours: 5,
        },
        {
          id: 'seven-day',
          label: '7-day limit',
          usedPercent: 30,
          resetLabel: '-',
          resetAtMs: NOW + DAY_MS,
          periodHours: 168,
        },
      ],
    };
    const ledger = buildClaudeLedger(quota, i18n.t);
    expect(ledger.windows.map((window) => window.id)).toEqual(['seven-day', 'five-hour']);
    const summary = summarizeProvider([ledger, ledger], NOW);
    expect(summary.headline?.id).toBe('seven-day');
    expect(summary.headline?.totalRemaining).toBe(140);
    expect(buildLedgerColumns([ledger]).map((column) => column.id)).not.toContain(
      'seven-day-fable'
    );
  });

  test('Codex leads with the weekly account window', () => {
    const quota: CodexQuotaState = {
      status: 'success',
      planType: 'plus',
      windows: [
        {
          id: 'five-hour',
          label: '5h',
          usedPercent: 10,
          resetLabel: '-',
          resetAtMs: NOW + HOUR_MS,
          periodHours: 5,
        },
        {
          id: 'weekly',
          label: 'weekly',
          usedPercent: 83,
          resetLabel: '-',
          resetAtMs: NOW + 2 * DAY_MS,
          periodHours: 168,
        },
      ],
    };
    const ledger = buildCodexLedger(quota, i18n.t);
    expect(ledger.plan).toBe(i18n.t('codex_quota.plan_plus'));
    expect(ledger.windows.map((window) => [window.id, window.remaining])).toEqual([
      ['weekly', 17],
      ['five-hour', 90],
    ]);
  });

  const billing = (overrides: Partial<XaiBillingSummary>): XaiBillingSummary => ({
    mode: 'billing',
    periodType: 'weekly',
    usagePercent: 40,
    productUsage: [],
    monthlyLimitCents: null,
    usedCents: null,
    includedUsedCents: null,
    onDemandCapCents: null,
    onDemandUsedCents: null,
    onDemandUsedPercent: null,
    usedPercent: null,
    resetAtMs: NOW + DAY_MS,
    periodEnd: new Date(NOW + DAY_MS).toISOString(),
    ...overrides,
  });

  test('xAI exposes the weekly limit, and paid-health accounts expose only a plan', () => {
    const weekly: XaiQuotaState = { status: 'success', billing: billing({}) };
    const ledger = buildXaiLedger(weekly, i18n.t);
    expect(ledger.windows.map((window) => [window.id, window.remaining])).toEqual([['weekly', 60]]);

    const paid: XaiQuotaState = {
      status: 'success',
      billing: billing({ mode: 'paid-health', planLabel: 'SuperGrok Heavy' }),
    };
    expect(buildXaiLedger(paid, i18n.t)).toEqual({ plan: 'SuperGrok Heavy', windows: [] });
  });

  test('Antigravity prefixes bucket labels with the group only when there are several', () => {
    const bucket = {
      id: 'weekly',
      label: 'Weekly limit',
      remainingFraction: 0.25,
      periodHours: 168,
    };
    const single: AntigravityQuotaState = {
      status: 'success',
      groups: [{ id: 'gemini', label: 'Gemini models', buckets: [bucket] }],
    };
    const double: AntigravityQuotaState = {
      status: 'success',
      groups: [
        { id: 'gemini', label: 'Gemini models', buckets: [bucket] },
        { id: 'claude', label: 'Claude and GPT models', buckets: [bucket] },
      ],
    };
    const one = buildAntigravityLedger(single, i18n.t);
    expect(one.windows.map((window) => [window.label, window.remaining])).toEqual([
      [i18n.t('antigravity_quota.weekly_limit'), 25],
    ]);
    const two = buildAntigravityLedger(double, i18n.t);
    expect(two.windows.map((window) => window.id)).toEqual(['gemini:weekly', 'claude:weekly']);
    expect(two.windows[0].label).toContain(i18n.t('antigravity_quota.group_gemini_models'));
  });
});
