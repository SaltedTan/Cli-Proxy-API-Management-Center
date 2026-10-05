/**
 * Quota pace: the per-window verdict, the provider tally behind the summary
 * strip, and the providers that must not be paced because their cycle length
 * is a client-side guess.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import type { TFunction } from 'i18next';
import { QuotaPaceProvider } from '@/features/quota/components/QuotaPace';
import { QuotaSummaryStrip } from '@/features/quota/components/QuotaSummaryStrip';
import {
  summarizeProvider,
  type LedgerSnapshot,
  type LedgerWindow,
} from '@/features/quota/ledgerModel';
import { computeWindowPace, type KnownPace } from '@/features/quota/paceModel';
import { AntigravityQuotaBody } from '@/features/quota/providers/antigravity/AntigravityQuotaBody';
import { buildAntigravityLedger } from '@/features/quota/providers/antigravity/ledger';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import { buildClaudeLedger } from '@/features/quota/providers/claude/ledger';
import { CodexQuotaBody } from '@/features/quota/providers/codex/CodexQuotaBody';
import { buildCodexLedger } from '@/features/quota/providers/codex/ledger';
import { DevinQuotaBody } from '@/features/quota/providers/devin/DevinQuotaBody';
import { buildDevinLedger } from '@/features/quota/providers/devin/ledger';
import { KimiQuotaBody } from '@/features/quota/providers/kimi/KimiQuotaBody';
import { buildKimiLedger } from '@/features/quota/providers/kimi/ledger';
import { MetaQuotaBody } from '@/features/quota/providers/meta/MetaQuotaBody';
import { buildMetaLedger } from '@/features/quota/providers/meta/ledger';
import { XaiQuotaBody } from '@/features/quota/providers/xai/XaiQuotaBody';
import { buildXaiLedger } from '@/features/quota/providers/xai/ledger';
import {
  QUOTA_CLASS_KEYS,
  bindPaceClasses,
  bindQuotaClasses,
  type PaceClassMap,
  type QuotaBodyProps,
} from '@/features/quota/types';
import { buildKimiQuotaRows } from '@/utils/quota';
import { HOUR_MS } from '@/utils/time/durations';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  XaiBillingSummary,
  XaiQuotaState,
} from '@/types';

const NOW = new Date(2026, 8, 10, 12).getTime();
const WEEK_HOURS = 24 * 7;

/** A weekly window with `elapsed` percent of its cycle gone and `remaining` percent left. */
const weekly = (remaining: number | null, elapsed: number): LedgerWindow => ({
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

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('computeWindowPace', () => {
  test('spending faster than the clock is over pace and runs out before the reset', () => {
    // 50% used with 25% of the week gone: twice the even rate.
    const pace = known(weekly(50, 25));
    expect(pace.status).toBe('over');
    expect(pace.expectedRemaining).toBeCloseTo(75);
    expect(pace.reservePoints).toBeCloseTo(-25);
    // The remaining 50% lasts as long as the first 50% took: another quarter week.
    expect(pace.exhaustedAtMs).toBeCloseTo(NOW + 0.25 * WEEK_HOURS * HOUR_MS, -3);
    expect(pace.early).toBe(false);
  });

  test('spending slower than the clock is under pace and lasts to the reset', () => {
    const pace = known(weekly(80, 50));
    expect(pace.status).toBe('under');
    expect(pace.reservePoints).toBeCloseTo(30);
    expect(pace.exhaustedAtMs).toBeNull();
  });

  test('a reserve within the one-point deadband reads as on pace', () => {
    expect(known(weekly(49.2, 50)).status).toBe('on');
    expect(known(weekly(51, 50)).status).toBe('on');
    expect(known(weekly(48.5, 50)).status).toBe('over');
  });

  test('an untouched window has no exhaustion projection', () => {
    const pace = known(weekly(100, 40));
    expect(pace.status).toBe('under');
    expect(pace.exhaustedAtMs).toBeNull();
  });

  test('an empty window is exhausted now', () => {
    expect(known(weekly(0, 60)).exhaustedAtMs).toBe(NOW);
  });

  test('the first tenth of a cycle is marked early', () => {
    expect(known(weekly(90, 5)).early).toBe(true);
    expect(known(weekly(90, 15)).early).toBe(false);
  });

  test('tolerates a reset a hair beyond one period, clamping to a fresh cycle', () => {
    const pace = known({ ...weekly(100, 0), resetAtMs: NOW + WEEK_HOURS * HOUR_MS * 1.005 });
    expect(pace.elapsedPercent).toBe(0);
  });

  test('stays unknown without trusted usage or cycle evidence', () => {
    const reason = (window: LedgerWindow) => {
      const pace = computeWindowPace(window, NOW);
      return pace.status === 'unknown' ? pace.reason : pace.status;
    };
    expect(reason(weekly(null, 50))).toBe('missing_usage');
    expect(reason({ ...weekly(50, 50), resetAtMs: null })).toBe('missing_cycle');
    expect(reason({ ...weekly(50, 50), periodHours: null })).toBe('missing_cycle');
    expect(reason({ ...weekly(50, 50), periodEstimated: true })).toBe('missing_cycle');
    expect(reason({ ...weekly(50, 50), resetAtMs: NOW - HOUR_MS })).toBe('expired_reset');
    expect(reason({ ...weekly(50, 50), resetAtMs: NOW + 2 * WEEK_HOURS * HOUR_MS })).toBe(
      'invalid_cycle'
    );
  });
});

describe('provider pace tally', () => {
  test('counts each loaded credential by verdict and skips unknown pace', () => {
    const summary = summarizeProvider(
      [
        { plan: null, windows: [weekly(40, 50)] },
        { plan: null, windows: [weekly(50, 50)] },
        { plan: null, windows: [weekly(90, 50)] },
        { plan: null, windows: [weekly(null, 50)] },
        null,
      ],
      NOW
    );
    expect(summary.headline?.pace).toEqual({ over: 1, on: 1, under: 1 });
  });

  test('the summary strip names the tally and leaves out empty verdicts', () => {
    const summary = summarizeProvider(
      [
        { plan: null, windows: [weekly(20, 50)] },
        { plan: null, windows: [weekly(10, 50)] },
        { plan: null, windows: [weekly(95, 50)] },
      ],
      NOW
    );
    const markup = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [{ provider: 'codex', summary }],
        resolvedTheme: 'dark',
        now: NOW,
      })
    );
    expect(markup).toContain('Pace');
    expect(markup).toContain('2 over');
    expect(markup).toContain('1 under');
    expect(markup).not.toContain(' on<');
  });

  test('the summary strip draws no tally when no credential has a known pace', () => {
    const summary = summarizeProvider([{ plan: null, windows: [weekly(null, 50)] }], NOW);
    const markup = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [{ provider: 'codex', summary }],
        resolvedTheme: 'dark',
        now: NOW,
      })
    );
    expect(markup).not.toContain('Pace');
  });
});

describe('guessed cycles are not paced', () => {
  const xaiBilling = (overrides: Partial<XaiBillingSummary>): XaiBillingSummary => ({
    mode: 'billing',
    periodType: 'monthly',
    usagePercent: null,
    productUsage: [],
    monthlyLimitCents: 10_000,
    usedCents: 4_000,
    includedUsedCents: null,
    onDemandCapCents: null,
    onDemandUsedCents: null,
    onDemandUsedPercent: null,
    usedPercent: 40,
    ...overrides,
  });
  const t = i18n.t.bind(i18n);

  test('xAI monthly credits pace on the reported billing span', () => {
    const ledger = buildXaiLedger(
      {
        status: 'success',
        billing: xaiBilling({
          billingPeriodStart: '2026-09-01T00:00:00Z',
          billingPeriodEnd: '2026-10-01T00:00:00Z',
        }),
      },
      t
    );
    const monthly = ledger.windows.find((window) => window.id === 'monthly');
    expect(monthly?.periodHours).toBe(30 * 24);
    expect(monthly?.periodEstimated).toBe(false);
  });

  test('xAI monthly credits without a period start keep 30 days for ordering only', () => {
    const ledger = buildXaiLedger(
      { status: 'success', billing: xaiBilling({ billingPeriodEnd: '2026-10-01T00:00:00Z' }) },
      t
    );
    const monthly = ledger.windows.find((window) => window.id === 'monthly');
    expect(monthly?.periodHours).toBe(30 * 24);
    expect(monthly?.periodEstimated).toBe(true);
    expect(computeWindowPace(monthly as LedgerWindow, NOW).status).toBe('unknown');
  });

  test('Kimi paces windows with duration metadata or a weekly label, not a label-read month', () => {
    const rows = buildKimiQuotaRows({
      limits: [
        {
          detail: { limit: '100', used: '5', resetTime: '2099-09-27T00:30:34Z' },
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        },
      ],
      usage: { limit: '100', used: '40', resetTime: '2099-09-30T16:48:39Z' },
      usages: { limit_month_total: { used_ratio: 0.25, reset_time: '2099-10-22T00:00:00Z' } },
    });
    const ledger = buildKimiLedger({ status: 'success', rows }, t);
    const estimated = Object.fromEntries(
      ledger.windows.map((window) => [window.id, window.periodEstimated])
    );
    expect(estimated).toEqual({ summary: false, 'limit-0': false, monthly: true });
  });
});

describe('pace source contracts', () => {
  const pace = readFileSync('src/features/quota/components/QuotaPace.tsx', 'utf8');

  test('the pace mark is decorative and the verdict carries its detail for screen readers', () => {
    expect(pace).toMatch(/className={classes.paceMark}[\s\S]{0,120}aria-hidden="true"/);
    expect(pace).toContain('<span className={classes.srOnly}>{detail}</span>');
  });

  test('early cycles do not project a run-out', () => {
    expect(pace).toContain("pace.status === 'over' && !pace.early");
  });

  test('provider bodies stay stylesheet-free: pace classes come from the host', () => {
    expect(pace).not.toMatch(/import .*\.scss/);
  });
});

describe('card bodies pace their rows by ledger window id', () => {
  /**
   * useNow() freezes to module-load time under renderToStaticMarkup, so the
   * fixtures sit relative to the real clock: half the quota gone with a quarter
   * of the week elapsed — over pace on every provider.
   */
  const now = Date.now();
  const weekMs = WEEK_HOURS * HOUR_MS;
  const resetAtMs = now + 0.75 * weekMs;
  const resetIso = new Date(resetAtMs).toISOString();
  const t = i18n.t.bind(i18n) as TFunction;
  const classes = bindQuotaClasses(
    Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
    'test-host'
  );
  const paceClasses: PaceClassMap = bindPaceClasses(
    new Proxy({}, { get: (_, key) => String(key) }) as Record<string, string>,
    'test-host'
  );

  const render = <T>(
    Body: (props: QuotaBodyProps<T>) => ReturnType<typeof createElement> | null,
    quota: T,
    snapshot: LedgerSnapshot | null
  ) =>
    renderToStaticMarkup(
      createElement(QuotaPaceProvider, {
        snapshot,
        classes: paceClasses,
        children: createElement(Body as never, { quota, classes }),
      })
    );

  const weeklyCodexLike = {
    id: 'seven-day',
    label: 'Weekly limit',
    usedPercent: 50,
    resetLabel: '',
    resetAtMs,
    periodHours: WEEK_HOURS,
  };
  const xaiBilling: XaiBillingSummary = {
    mode: 'billing',
    periodType: 'weekly',
    usagePercent: 50,
    periodEnd: resetIso,
    resetAtMs,
    periodHours: WEEK_HOURS,
    productUsage: [],
    monthlyLimitCents: 10_000,
    usedCents: 5_000,
    includedUsedCents: 5_000,
    onDemandCapCents: null,
    onDemandUsedCents: null,
    onDemandUsedPercent: null,
    usedPercent: 50,
    billingPeriodStart: new Date(now - 0.25 * 30 * 24 * HOUR_MS).toISOString(),
    billingPeriodEnd: new Date(now + 0.75 * 30 * 24 * HOUR_MS).toISOString(),
  };

  const cases: [string, () => [string, LedgerSnapshot], number][] = [
    [
      'antigravity',
      () => {
        const quota: AntigravityQuotaState = {
          status: 'success',
          groups: [
            {
              id: 'gemini',
              label: 'Gemini',
              buckets: [
                {
                  id: 'weekly',
                  label: 'Weekly',
                  remainingFraction: 0.5,
                  resetTime: resetIso,
                  resetAtMs,
                  periodHours: WEEK_HOURS,
                },
              ],
            },
          ],
        };
        const snapshot = buildAntigravityLedger(quota, t);
        return [render(AntigravityQuotaBody, quota, snapshot), snapshot];
      },
      1,
    ],
    [
      'claude',
      () => {
        const quota: ClaudeQuotaState = { status: 'success', windows: [weeklyCodexLike] };
        const snapshot = buildClaudeLedger(quota, t);
        return [render(ClaudeQuotaBody, quota, snapshot), snapshot];
      },
      1,
    ],
    [
      'codex',
      () => {
        const quota: CodexQuotaState = { status: 'success', windows: [weeklyCodexLike] };
        const snapshot = buildCodexLedger(quota, t);
        return [render(CodexQuotaBody, quota, snapshot), snapshot];
      },
      1,
    ],
    [
      'devin',
      () => {
        const quota: DevinQuotaState = {
          status: 'success',
          windows: [{ id: 'weekly', remainingPercent: 50, resetAtMs, periodHours: WEEK_HOURS }],
          observedAtMs: null,
          plan: null,
          planStartMs: null,
          planEndMs: null,
        };
        const snapshot = buildDevinLedger(quota, t);
        return [render(DevinQuotaBody, quota, snapshot), snapshot];
      },
      1,
    ],
    [
      'kimi',
      () => {
        const quota: KimiQuotaState = {
          status: 'success',
          rows: [
            {
              id: 'summary',
              label: 'Weekly limit',
              used: 50,
              limit: 100,
              resetAtMs,
              periodHours: WEEK_HOURS,
            },
          ],
        };
        const snapshot = buildKimiLedger(quota, t);
        return [render(KimiQuotaBody, quota, snapshot), snapshot];
      },
      1,
    ],
    [
      'meta',
      () => {
        const quota: MetaQuotaState = {
          status: 'success',
          data: { windows: [{ id: 'weekly', usedPercent: 50, resetAt: resetAtMs / 1000 }] },
        };
        const snapshot = buildMetaLedger(quota, t);
        return [render(MetaQuotaBody, quota, snapshot), snapshot];
      },
      1,
    ],
    [
      'xai (weekly limit and monthly credits)',
      () => {
        const quota: XaiQuotaState = { status: 'success', billing: xaiBilling };
        const snapshot = buildXaiLedger(quota, t);
        return [render(XaiQuotaBody, quota, snapshot), snapshot];
      },
      2,
    ],
  ];

  test.each(cases)('%s', (_, run, rows) => {
    const [markup] = run();
    expect(markup.match(/class="paceMark"/g)?.length).toBe(rows);
    expect(markup.match(/class="pace paceOver"/g)?.length).toBe(rows);
    expect(markup).toContain('Over pace · runs out');
    expect(markup).toContain('50% used with 25% of the window elapsed');
  });

  test('without a ledger snapshot a body draws no pace', () => {
    const quota: CodexQuotaState = { status: 'success', windows: [weeklyCodexLike] };
    const markup = render(CodexQuotaBody, quota, null);
    expect(markup).not.toContain('paceMark');
    expect(markup).not.toContain('Over pace');
  });

  test('a host stylesheet missing a pace class fails loudly', () => {
    expect(() => bindPaceClasses({ meter: 'meter' }, 'broken.scss')).toThrow(/paceMark/);
  });
});
