/**
 * A sliver of quota is not used up: models keep exact percentages and only
 * display rounds, so "Used up" and "0%" mean an actually empty window.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import { PaceVerdict } from '@/features/quota/components/QuotaPace';
import { QuotaSummaryStrip } from '@/features/quota/components/QuotaSummaryStrip';
import {
  displayPercent,
  formatPercent,
  summarizeProvider,
  type LedgerWindow,
} from '@/features/quota/ledgerModel';
import { computeWindowPace, type KnownPace } from '@/features/quota/paceModel';
import { AntigravityQuotaBody } from '@/features/quota/providers/antigravity/AntigravityQuotaBody';
import { buildAntigravityLedger } from '@/features/quota/providers/antigravity/ledger';
import { KimiQuotaBody } from '@/features/quota/providers/kimi/KimiQuotaBody';
import { buildKimiLedger } from '@/features/quota/providers/kimi/ledger';
import {
  QUOTA_CLASS_KEYS,
  bindPaceClasses,
  bindQuotaClasses,
  type PaceClassMap,
} from '@/features/quota/types';
import { buildKimiQuotaRows } from '@/utils/quota';
import { HOUR_MS } from '@/utils/time/durations';
import type { AntigravityQuotaState, KimiQuotaState } from '@/types';

const NOW = new Date(2026, 9, 9, 12).getTime();
const WEEK_HOURS = 24 * 7;
const t = i18n.t.bind(i18n) as TFunction;

const weekly = (remaining: number, elapsed: number): LedgerWindow => ({
  id: 'weekly',
  label: 'Weekly limit',
  remaining,
  resetAtMs: NOW + ((100 - elapsed) / 100) * WEEK_HOURS * HOUR_MS,
  resetLabel: null,
  periodHours: WEEK_HOURS,
});

const known = (window: LedgerWindow): KnownPace => {
  const pace = computeWindowPace(window, NOW);
  if (pace.status === 'unknown') throw new Error(`expected a known pace, got ${pace.reason}`);
  return pace;
};

const quotaClasses = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);
const paceClasses: PaceClassMap = bindPaceClasses(
  new Proxy({}, { get: (_, key) => String(key) }) as Record<string, string>,
  'test-host'
);

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('display rounding', () => {
  test('rounds to whole percents, but never a sliver into empty or full', () => {
    expect(displayPercent(0)).toBe('0');
    expect(displayPercent(0.4)).toBe('<1');
    expect(displayPercent(1.4)).toBe('1');
    expect(displayPercent(41.5)).toBe('42');
    expect(displayPercent(99.6)).toBe('>99');
    expect(displayPercent(100)).toBe('100');
    expect(formatPercent(0.4)).toBe('<1%');
    expect(formatPercent(null)).toBe('--');
  });
});

describe('ledger adapters keep exact percentages', () => {
  test('Antigravity: 0.4% left is not 0%', () => {
    const quota: AntigravityQuotaState = {
      status: 'success',
      groups: [
        {
          id: 'gemini',
          label: 'Gemini models',
          buckets: [{ id: 'weekly', label: 'Weekly limit', remainingFraction: 0.004 }],
        },
      ],
    };
    expect(buildAntigravityLedger(quota, t).windows[0].remaining).toBeCloseTo(0.4, 10);
  });

  test('Kimi: 999 of 1000 used leaves 0.1%, and a full count is empty', () => {
    const quota: KimiQuotaState = {
      status: 'success',
      rows: [
        { id: 'summary', label: 'Weekly', used: 999, limit: 1000 },
        { id: 'limit-0', label: '5h', used: 1000, limit: 1000 },
      ],
    };
    const [summary, session] = buildKimiLedger(quota, t).windows;
    expect(summary.remaining).toBeCloseTo(0.1, 10);
    expect(session.remaining).toBe(0);
  });

  test('Kimi: a month 99.6% spent keeps its last 0.4%', () => {
    const rows = buildKimiQuotaRows({
      usages: { limit_month_total: { used_ratio: 0.996, reset_time: '2099-10-22T00:00:00Z' } },
    });
    const quota: KimiQuotaState = { status: 'success', rows };
    expect(buildKimiLedger(quota, t).windows[0].remaining).toBeCloseTo(0.4, 10);
  });
});

describe('Used up means empty', () => {
  const verdict = (window: LedgerWindow) =>
    renderToStaticMarkup(
      createElement(PaceVerdict, {
        pace: known(window),
        remaining: window.remaining as number,
        now: NOW,
        classes: paceClasses,
      })
    );

  test('a sliver left is over pace, not used up', () => {
    const markup = verdict(weekly(0.4, 50));
    expect(markup).toContain('Over pace');
    expect(markup).not.toContain('Used up');
    expect(markup).toContain('&gt;99% used');
  });

  test('an empty window is used up', () => {
    const markup = verdict(weekly(0, 50));
    expect(markup).toContain('Used up');
    expect(markup).toContain('100% used');
  });

  test('the summary pools exact figures and shows a sliver as <1%', () => {
    const summary = summarizeProvider([{ plan: null, windows: [weekly(0.4, 50)] }], NOW);
    expect(summary.headline?.totalRemaining).toBeCloseTo(0.4, 10);
    const markup = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [{ provider: 'kimi', summary }],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    expect(markup).toContain('&lt;1%');
  });
});

describe('card bodies show a sliver as <1%', () => {
  test('Kimi', () => {
    const quota: KimiQuotaState = {
      status: 'success',
      rows: [{ id: 'summary', label: 'Weekly', used: 999, limit: 1000 }],
    };
    const markup = renderToStaticMarkup(
      createElement(KimiQuotaBody, { quota, classes: quotaClasses })
    );
    expect(markup).toContain('&lt;1%');
  });

  test('Antigravity', () => {
    const quota: AntigravityQuotaState = {
      status: 'success',
      groups: [
        {
          id: 'gemini',
          label: 'Gemini models',
          buckets: [{ id: 'weekly', label: 'Weekly limit', remainingFraction: 0.004 }],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(AntigravityQuotaBody, { quota, classes: quotaClasses })
    );
    expect(markup).toContain('&lt;1% remaining');
  });
});
