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

  test('a scoped window never headlines while an account-wide one exists', () => {
    const snapshot: LedgerSnapshot = {
      plan: 'Max',
      windows: [
        win({ id: 'fable', remaining: 30, periodHours: 168, scope: 'scoped', model: 'Fable' }),
        win({ id: 'seven-day', remaining: 90, periodHours: 168, scope: 'account' }),
        win({ id: 'oauth', remaining: 70, periodHours: 168, scope: 'scoped' }),
      ],
    };
    const summary = summarizeProvider([snapshot, snapshot], NOW);
    expect(summary.headline?.id).toBe('seven-day');
    // The model window becomes a model block; a scoped window without a model stays secondary.
    expect(summary.models.map((model) => model.line.id)).toEqual(['fable']);
    expect(summary.secondary.map((line) => line.id)).toEqual(['oauth']);
  });

  test('cloud session credits never headline beside an actual limit', () => {
    const credits = win({
      id: 'cloud-session-credits',
      remaining: 0,
      resetAtMs: NOW + HOUR_MS,
      scope: 'scoped',
    });
    const fable = win({
      id: 'seven-day-fable',
      remaining: 80,
      periodHours: 168,
      scope: 'scoped',
      model: 'Fable',
    });
    const both: LedgerSnapshot = { plan: 'Max', windows: [credits, fable] };
    expect(summarizeProvider([both, both], NOW).headline?.id).toBe('seven-day-fable');

    // With nothing else reported, the credits still headline.
    const only: LedgerSnapshot = { plan: 'Max', windows: [credits] };
    expect(summarizeProvider([only], NOW).headline?.id).toBe('cloud-session-credits');
  });

  test('model blocks count the credentials that could serve the model now', () => {
    const cycleStart = NOW - 4 * DAY_MS;
    const reset = cycleStart + 7 * DAY_MS;
    const credential = (fable: number, sevenDay: number, pauses?: LedgerSnapshot['pauses']) => ({
      plan: 'Max',
      // Claude's ledger order: account-wide 7-day first, then the session, then Fable.
      windows: [
        win({
          id: 'seven-day',
          remaining: sevenDay,
          resetAtMs: reset,
          periodHours: 168,
          scope: 'account',
        }),
        win({ id: 'five-hour', remaining: 90, periodHours: 5, scope: 'account' }),
        win({
          id: 'fable',
          remaining: fable,
          resetAtMs: reset,
          periodHours: 168,
          scope: 'scoped',
          model: 'Fable',
        }),
      ],
      ...(pauses ? { pauses } : {}),
    });
    const summary = summarizeProvider(
      [
        credential(80, 80),
        // Over pace: 4 of 7 days gone with only 10% left — runs out before the reset.
        credential(10, 80),
        credential(0, 80, [{ scope: 'model', modelKey: 'claude-fable-5-1', untilMs: reset }]),
        null,
      ],
      NOW
    );
    expect(summary.headline?.id).toBe('seven-day');
    const [fable] = summary.models;
    expect(fable.model).toBe('Fable');
    expect(fable.carrying).toBe(3);
    expect(fable.serving).toBe(2);
    expect(fable.short).toBe(1);
    expect(fable.firstStopMs).not.toBeNull();
    expect(fable.firstStopMs as number).toBeLessThan(reset);
    expect(fable.line.capacity).toBe(400);
    expect(fable.line.totalRemaining).toBe(90);
  });

  test('reports no headline when nothing is loaded', () => {
    const summary = summarizeProvider([null, null], NOW);
    expect(summary.headline).toBeNull();
    expect(summary.models).toEqual([]);
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

  describe('weighted windows', () => {
    // Claude's ledger shape: the 7-day headline, the weighted session, a scoped extra.
    const credential = (
      sevenDay: number,
      session: number | null,
      weight: number,
      weightAssumed = false
    ): LedgerSnapshot => ({
      plan: null,
      windows: [
        win({ id: 'seven-day', remaining: sevenDay, periodHours: 168, scope: 'account' }),
        win({
          id: 'five-hour',
          remaining: session,
          resetAtMs: NOW + HOUR_MS,
          periodHours: 5,
          scope: 'account',
          weight,
          ...(weightAssumed ? { weightAssumed } : {}),
        }),
        win({ id: 'oauth', remaining: 90, periodHours: 168, scope: 'scoped' }),
      ],
    });
    /**
     * A Max 20x out of its 7-day limit, its 5-hour session reading untouched —
     * or, with `sevenDay` given, the same account with that much of the week left.
     */
    const gatedMax20 = (
      sevenDayResetAtMs: number | null,
      session: number | null = 100,
      sessionResetAtMs: number | null = null,
      sevenDay = 0
    ): LedgerSnapshot => ({
      plan: null,
      windows: [
        win({
          id: 'seven-day',
          remaining: sevenDay,
          resetAtMs: sevenDayResetAtMs,
          periodHours: 168,
          scope: 'account',
        }),
        win({
          id: 'five-hour',
          remaining: session,
          resetAtMs: sessionResetAtMs,
          periodHours: 5,
          scope: 'account',
          weight: 20,
        }),
      ],
    });
    // Pro, Team, Max 5x and Max 20x, plus one credential not loaded yet.
    const pool = [
      credential(80, 50, 1),
      credential(60, 80, 1.25),
      credential(40, 40, 5),
      credential(20, 90, 20),
      null,
    ];

    test('pools remaining × weight against 100 × weight per loaded credential', () => {
      const [session] = summarizeProvider(pool, NOW).weighted;
      expect(session.id).toBe('five-hour');
      // 50 + 80 × 1.25 + 40 × 5 + 90 × 20
      expect(session.totalRemaining).toBe(2150);
      // 100 + 125 + 500 + 2000. The unloaded credential's plan is unknown, so it is
      // left out of the pool — no capacity, and no segment the bar would draw.
      expect(session.capacity).toBe(2725);
      expect(session.segments).toEqual([50, 80, 40, 90]);
      expect(session.weighting).toEqual({ weights: [1, 1.25, 5, 20], assumed: 0, gated: 0 });
      expect(session.coverage).toBe(4);
      expect(session.nextResetMs).toBe(NOW + HOUR_MS);
    });

    test('lists the weighted line apart from the folded secondary lines', () => {
      const summary = summarizeProvider(pool, NOW);
      expect(summary.headline?.id).toBe('seven-day');
      expect(summary.weighted.map((line) => line.id)).toEqual(['five-hour']);
      expect(summary.secondary.map((line) => line.id)).toEqual(['oauth']);
    });

    test('leaves unweighted lines exactly as they were', () => {
      const summary = summarizeProvider(pool, NOW);
      expect(summary.headline).toEqual({
        id: 'seven-day',
        label: 'seven-day',
        totalRemaining: 200,
        capacity: 500,
        segments: [80, 60, 40, 20, null],
        nextResetMs: null,
        coverage: 4,
        pace: { over: 0, on: 0, under: 0 },
      });
      expect('weighting' in summary.secondary[0]).toBe(false);
      expect(summary.secondary[0].capacity).toBe(500);
      expect(summarizeProvider(snapshots, NOW).weighted).toEqual([]);

      // Gating changes weighted lines only: with the weights stripped, every line
      // (the 5-hour one included) pools exactly as an unweighted line always has.
      const withGate = [...pool, gatedMax20(NOW + 2 * DAY_MS)];
      const unweighted = withGate.map((snapshot) =>
        snapshot === null
          ? null
          : {
              ...snapshot,
              windows: snapshot.windows.map(
                ({ weight: _weight, weightAssumed: _assumed, ...window }) => window
              ),
            }
      );
      const weightedSummary = summarizeProvider(withGate, NOW);
      const plain = summarizeProvider(unweighted, NOW);
      expect(weightedSummary.headline).toEqual(plain.headline);
      expect(weightedSummary.secondary).toEqual(
        plain.secondary.filter((l) => l.id !== 'five-hour')
      );
      const plainSession = plain.secondary.find((line) => line.id === 'five-hour');
      expect(plainSession?.totalRemaining).toBe(50 + 80 + 40 + 90 + 100);
      expect(plainSession?.capacity).toBe(600);
    });

    test('counts stand-in weights, and still pools a credential without a figure', () => {
      const [session] = summarizeProvider(
        [credential(80, 30, 20), credential(80, null, 1, true), credential(80, 70, 1, true)],
        NOW
      ).weighted;
      expect(session.totalRemaining).toBe(670);
      expect(session.capacity).toBe(2200);
      expect(session.segments).toEqual([30, null, 70]);
      expect(session.weighting?.assumed).toBe(2);
    });

    test('keeps segments and weights aligned past a credential without the window', () => {
      const withoutSession: LedgerSnapshot = {
        plan: null,
        windows: [win({ id: 'seven-day', remaining: 50, periodHours: 168, scope: 'account' })],
      };
      const summary = summarizeProvider(
        [credential(80, 40, 5), withoutSession, null, credential(80, 90, 20)],
        NOW
      );
      const [session] = summary.weighted;
      expect(session.segments).toEqual([40, 90]);
      expect(session.weighting?.weights).toEqual([5, 20]);
      expect(session.capacity).toBe(2500);
      expect(session.coverage).toBe(2);
      // The unweighted headline still keeps a blank segment for the unloaded credential.
      expect(summary.headline?.segments).toEqual([80, 50, null, 80]);
    });

    test('a weighted window headlines when nothing else is reported, still weighted', () => {
      const sessionOnly = (session: number, weight: number): LedgerSnapshot => ({
        plan: null,
        windows: [win({ id: 'five-hour', remaining: session, periodHours: 5, weight })],
      });
      const summary = summarizeProvider([sessionOnly(50, 1), sessionOnly(10, 20), null], NOW);
      expect(summary.headline?.id).toBe('five-hour');
      expect(summary.headline?.capacity).toBe(2100);
      expect(summary.headline?.totalRemaining).toBe(250);
      expect(summary.headline?.segments).toEqual([50, 10]);
      expect(summary.weighted).toEqual([]);
    });

    describe('a credential out of its 7-day limit', () => {
      const pro = (session: number, resetAtMs: number | null): LedgerSnapshot => ({
        plan: null,
        windows: [
          win({ id: 'seven-day', remaining: 60, periodHours: 168, scope: 'account' }),
          win({
            id: 'five-hour',
            remaining: session,
            resetAtMs,
            periodHours: 5,
            scope: 'account',
            weight: 1,
          }),
        ],
      });
      const sessionOf = (pooled: (LedgerSnapshot | null)[]) =>
        summarizeProvider(pooled, NOW).weighted[0];

      test('keeps its weight in capacity but counts none of its full session as left', () => {
        const session = sessionOf([pro(40, null), gatedMax20(NOW + 2 * DAY_MS)]);
        expect(session.capacity).toBe(2100);
        expect(session.totalRemaining).toBe(40);
        expect(session.segments).toEqual([40, 0]);
        expect(session.weighting).toEqual({ weights: [1, 20], assumed: 0, gated: 1 });
        // It next tops up when the 7-day limit resets…
        expect(session.nextResetMs).toBe(NOW + 2 * DAY_MS);
        // …unless another credential's session refills first.
        expect(sessionOf([pro(40, NOW + HOUR_MS), gatedMax20(NOW + 2 * DAY_MS)]).nextResetMs).toBe(
          NOW + HOUR_MS
        );
      });

      test('a 7-day reading whose reset has passed has already reset, so gates nothing', () => {
        const session = sessionOf([pro(40, null), gatedMax20(NOW - HOUR_MS)]);
        expect(session.totalRemaining).toBe(40 + 2000);
        expect(session.segments).toEqual([40, 100]);
        expect(session.weighting?.gated).toBe(0);
      });

      test('an unknown 7-day reset still gates, with no top-up to report', () => {
        const session = sessionOf([pro(40, null), gatedMax20(null)]);
        expect(session.totalRemaining).toBe(40);
        expect(session.weighting?.gated).toBe(1);
        expect(session.nextResetMs).toBeNull();
      });

      test('its own session neither paces nor names the next top-up', () => {
        // 90% used an hour into the session: over pace, were it not gated.
        const sessionReset = NOW + 4 * HOUR_MS;
        const open = sessionOf([gatedMax20(NOW + 2 * DAY_MS, 10, sessionReset, 50)]);
        expect(open.pace).toEqual({ over: 1, on: 0, under: 0 });
        expect(open.nextResetMs).toBe(sessionReset);
        const gated = sessionOf([gatedMax20(NOW + 2 * DAY_MS, 10, sessionReset)]);
        expect(gated.pace).toEqual({ over: 0, on: 0, under: 0 });
        expect(gated.nextResetMs).toBe(NOW + 2 * DAY_MS);
        expect(gated.totalRemaining).toBe(0);
      });

      test('with several used-up limits, it waits on the one that lifts last', () => {
        const twoGates: LedgerSnapshot = {
          ...gatedMax20(NOW + DAY_MS),
          windows: [
            ...gatedMax20(NOW + DAY_MS).windows,
            win({
              id: 'seven-day-other',
              remaining: 0,
              resetAtMs: NOW + 3 * DAY_MS,
              scope: 'account',
            }),
            // A scoped limit never gates the whole account.
            win({ id: 'scoped', remaining: 0, resetAtMs: NOW + 5 * DAY_MS, scope: 'scoped' }),
          ],
        };
        expect(sessionOf([twoGates]).nextResetMs).toBe(NOW + 3 * DAY_MS);
      });

      test('tops up when quota actually comes back, as the proxy reckons it', () => {
        const lift = NOW + HOUR_MS;
        const later = NOW + 4 * HOUR_MS;
        const topUp = (session: number | null, sessionResetAtMs: number | null) =>
          sessionOf([gatedMax20(lift, session, sessionResetAtMs)]).nextResetMs;
        // A spent session that resets after the lift: nothing is usable until it does.
        expect(topUp(0, later)).toBe(later);
        // …and with its reset unknown, nothing is known to come back at all.
        expect(topUp(0, null)).toBeNull();
        // A part-used session: its unused part comes back at the lift.
        expect(topUp(30, later)).toBe(lift);
        expect(topUp(30, null)).toBe(lift);
        // A session that resets before the lift, or is untouched, all comes back at the lift.
        expect(sessionOf([gatedMax20(later, 0, lift)]).nextResetMs).toBe(later);
        expect(topUp(100, later)).toBe(lift);
        // No session figure: the lift, as before.
        expect(topUp(null, later)).toBe(lift);
      });

      test('only an account-wide limit gates; one without a scope does not', () => {
        const unscoped: LedgerSnapshot = {
          plan: null,
          windows: gatedMax20(NOW + 2 * DAY_MS).windows.map((window) =>
            window.id === 'seven-day' ? { ...window, scope: undefined } : window
          ),
        };
        const session = sessionOf([unscoped]);
        expect(session.weighting?.gated).toBe(0);
        expect(session.totalRemaining).toBe(2000);
      });
    });

    test('nothing loaded yet leaves no weighted line', () => {
      const summary = summarizeProvider([null, null], NOW);
      expect(summary.weighted).toEqual([]);
    });
  });
});

describe('provider ledger extractors', () => {
  test('every quota provider registers a ledger extractor', () => {
    for (const type of QUOTA_TAB_ORDER) {
      expect(typeof QUOTA_ADAPTERS[type].ledger).toBe('function');
    }
  });

  test('Claude leads with the account-wide 7-day limit and reads percent remaining', () => {
    const quota: ClaudeQuotaState = {
      status: 'success',
      planType: 'plan_max',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'claude_quota.five_hour',
          scope: 'account',
          usedPercent: 0,
          resetLabel: '-',
          resetAtMs: null,
          periodHours: 5,
        },
        {
          id: 'seven-day',
          label: '7-day limit',
          labelKey: 'claude_quota.seven_day',
          scope: 'account',
          usedPercent: 21,
          resetLabel: '-',
          resetAtMs: NOW + DAY_MS,
          periodHours: 168,
        },
        {
          id: 'seven-day-fable',
          label: '7-day Fable',
          labelKey: 'claude_quota.seven_day_model',
          labelParams: { model: 'Fable 5.1' },
          scope: 'scoped',
          model: 'Fable 5.1',
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
      'seven-day',
      'five-hour',
      'seven-day-fable',
    ]);
    expect(ledger.windows.map((window) => window.remaining)).toEqual([79, 100, 58]);
    expect(ledger.windows[1].resetAtMs).toBeNull();
    // Scope and model survive into the ledger, and the label is the payload's model name.
    expect(ledger.windows.map((window) => window.scope)).toEqual(['account', 'account', 'scoped']);
    expect(ledger.windows[2]).toMatchObject({ model: 'Fable 5.1', label: '7-day Fable 5.1' });
  });

  test('Claude shows the Max size when the profile reports one', () => {
    const quota: ClaudeQuotaState = { status: 'success', planType: 'plan_max5', windows: [] };
    expect(buildClaudeLedger(quota, i18n.t).plan).toBe('Max 5x');
  });

  describe('Claude 5-hour weights', () => {
    const claudeQuota = (planType: string | null, session = 50): ClaudeQuotaState => ({
      status: 'success',
      planType,
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'claude_quota.five_hour',
          scope: 'account',
          usedPercent: 100 - session,
          resetLabel: '-',
          resetAtMs: NOW + HOUR_MS,
          periodHours: 5,
        },
        {
          id: 'seven-day',
          label: '7-day limit',
          labelKey: 'claude_quota.seven_day',
          scope: 'account',
          usedPercent: 30,
          resetLabel: '-',
          resetAtMs: NOW + DAY_MS,
          periodHours: 168,
        },
      ],
    });

    test('weights only the 5-hour window, in Pro sessions by plan', () => {
      const cases: [string | null, number, boolean][] = [
        ['plan_pro', 1, false],
        ['plan_team', 1.25, false],
        ['plan_max5', 5, false],
        ['plan_max20', 20, false],
        // Unsized plans and a failed profile request count as one Pro, flagged.
        ['plan_max', 1, true],
        ['plan_free', 1, true],
        ['plan_enterprise', 1, true],
        [null, 1, true],
      ];
      for (const [planType, weight, assumed] of cases) {
        const ledger = buildClaudeLedger(claudeQuota(planType), i18n.t);
        const [sevenDay, session] = ledger.windows;
        expect(session.id).toBe('five-hour');
        expect(session.weight).toBe(weight);
        expect(session.weightAssumed === true).toBe(assumed);
        expect('weight' in sevenDay).toBe(false);
        expect('weightAssumed' in sevenDay).toBe(false);
      }
    });

    test('two Pro, a Max 5x and a Max 20x pool to 2700% of Pro sessions', () => {
      const summary = summarizeProvider(
        [
          buildClaudeLedger(claudeQuota('plan_pro', 40), i18n.t),
          buildClaudeLedger(claudeQuota('plan_pro', 60), i18n.t),
          buildClaudeLedger(claudeQuota('plan_max5', 20), i18n.t),
          buildClaudeLedger(claudeQuota('plan_max20', 75), i18n.t),
        ],
        NOW
      );
      expect(summary.headline?.id).toBe('seven-day');
      expect(summary.headline?.capacity).toBe(400);
      expect(summary.secondary).toEqual([]);
      const [session] = summary.weighted;
      expect(session.capacity).toBe(2700);
      expect(session.totalRemaining).toBe(40 + 60 + 100 + 1500);
      expect(session.weighting?.weights).toEqual([1, 1, 5, 20]);
    });
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
