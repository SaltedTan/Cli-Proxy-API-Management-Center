/**
 * Lanes: which window decides whether a credential can serve a model now.
 */

import { describe, expect, test } from 'bun:test';
import {
  OTHER_MODELS_LANE_ID,
  approximateInstant,
  buildLaneColumns,
  buildQuotaLanes,
  credentialBlockFromAuthFile,
  hasModelLanes,
  ledgerPausesFromCooldowns,
  type QuotaLane,
} from '@/features/quota/laneModel';
import {
  summarizeProvider,
  type CredentialBlock,
  type LedgerPause,
  type LedgerSnapshot,
  type LedgerWindow,
} from '@/features/quota/ledgerModel';
import type { AuthFileItem } from '@/types/authFile';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const NOW = new Date(2026, 9, 6, 14, 20).getTime();
/** Four of seven days gone: an even spend leaves ~43% of a weekly window now. */
const WEEKLY_RESET = NOW + 3 * DAY_MS;
/** Three of five hours gone: an even spend leaves 40% of the session now. */
const SESSION_RESET = NOW + 2 * HOUR_MS;

const fiveHour = (remaining: number | null, resetAtMs: number | null = SESSION_RESET) => ({
  id: 'five-hour',
  label: '5-hour limit',
  remaining,
  resetAtMs,
  resetLabel: null,
  periodHours: 5,
  scope: 'account' as const,
});
const sevenDay = (remaining: number | null, resetAtMs: number | null = WEEKLY_RESET) => ({
  id: 'seven-day',
  label: '7-day limit',
  remaining,
  resetAtMs,
  resetLabel: null,
  periodHours: 168,
  scope: 'account' as const,
});
const fable = (remaining: number | null, resetAtMs: number | null = WEEKLY_RESET) => ({
  id: 'seven-day-fable',
  label: '7-day Fable',
  remaining,
  resetAtMs,
  resetLabel: null,
  periodHours: 168,
  scope: 'scoped' as const,
  model: 'Fable',
});

const snapshot = (windows: LedgerWindow[], pauses?: LedgerPause[]): LedgerSnapshot => ({
  plan: 'Max 5x',
  windows,
  ...(pauses ? { pauses } : {}),
});

const lanesOf = (windows: LedgerWindow[], pauses?: LedgerPause[]) => {
  const lanes = buildQuotaLanes(snapshot(windows, pauses), NOW);
  const byId = (id: string) => lanes.find((lane) => lane.id === id) as QuotaLane;
  return { lanes, fableLane: byId('seven-day-fable'), otherLane: byId(OTHER_MODELS_LANE_ID) };
};

describe('buildQuotaLanes', () => {
  test('one lane per model limit, then one for every other model', () => {
    const { lanes } = lanesOf([sevenDay(80), fiveHour(90), fable(80)]);
    expect(lanes.map((lane) => [lane.id, lane.model])).toEqual([
      ['seven-day-fable', 'Fable'],
      [OTHER_MODELS_LANE_ID, null],
    ]);
  });

  test('healthy lanes are open and read their own limit', () => {
    const { fableLane, otherLane } = lanesOf([sevenDay(80), fiveHour(90), fable(70)]);
    expect(fableLane).toMatchObject({ status: 'open', runoutAtMs: null, reopenAtMs: null });
    expect(fableLane.gate.id).toBe('seven-day-fable');
    expect(otherLane.status).toBe('open');
    // The other-models lane reads the longest account-wide window, not the session.
    expect(otherLane.own.id).toBe('seven-day');
  });

  test('a model limit over pace runs its lane short without touching the others', () => {
    const { fableLane, otherLane } = lanesOf([sevenDay(80), fiveHour(90), fable(10)]);
    expect(fableLane.status).toBe('tight');
    expect(fableLane.gate.id).toBe('seven-day-fable');
    expect(fableLane.runoutAtMs).not.toBeNull();
    expect(fableLane.runoutAtMs as number).toBeLessThan(WEEKLY_RESET);
    expect(otherLane.status).toBe('open');
  });

  test('a 7-day limit that runs out first takes over the Fable lane', () => {
    // Fable is comfortably under pace; the 7-day limit empties within hours.
    const { fableLane, otherLane } = lanesOf([sevenDay(5), fiveHour(90), fable(70)]);
    expect(fableLane.status).toBe('tight');
    expect(fableLane.gate.id).toBe('seven-day');
    expect(fableLane.own.id).toBe('seven-day-fable');
    expect(otherLane).toMatchObject({ status: 'tight', runoutAtMs: fableLane.runoutAtMs });
  });

  test('the earlier of two projected run-outs decides the lane', () => {
    // Both over pace; the 7-day limit (5% left) empties well before Fable (30% left).
    const { fableLane } = lanesOf([sevenDay(5), fiveHour(90), fable(30)]);
    expect(fableLane.gate.id).toBe('seven-day');
  });

  test('a 5-hour projection never takes a lane over', () => {
    // 20% left with 60% of the session gone: over pace, empties before its reset.
    const { fableLane, otherLane } = lanesOf([sevenDay(80), fiveHour(20), fable(70)]);
    expect(fableLane.status).toBe('open');
    expect(otherLane.status).toBe('open');
  });

  test('an empty session closes every lane until it refills', () => {
    const { lanes } = lanesOf([sevenDay(60), fiveHour(0), fable(70)]);
    for (const lane of lanes) {
      expect(lane).toMatchObject({ status: 'closed', reopenAtMs: SESSION_RESET });
      expect(lane.gate.id).toBe('five-hour');
    }
  });

  test('an empty Fable limit closes only the Fable lane', () => {
    const { fableLane, otherLane } = lanesOf([sevenDay(60), fiveHour(90), fable(0)]);
    expect(fableLane).toMatchObject({ status: 'closed', reopenAtMs: WEEKLY_RESET });
    expect(otherLane.status).toBe('open');
  });

  test('a lane waits for the last of its empty gates to lift', () => {
    const later = WEEKLY_RESET + DAY_MS;
    const { fableLane } = lanesOf([sevenDay(0), fiveHour(0), fable(50, later)]);
    expect(fableLane.gate.id).toBe('seven-day');
    expect(fableLane.reopenAtMs).toBe(WEEKLY_RESET);
  });

  test('an empty gate without a reset leaves the reopening time unknown', () => {
    const { otherLane } = lanesOf([sevenDay(0, null), fiveHour(90)]);
    expect(otherLane).toMatchObject({ status: 'closed', reopenAtMs: null });
  });

  test("the proxy's model pause closes only that model's lane", () => {
    const until = NOW + 4 * DAY_MS;
    const { fableLane, otherLane } = lanesOf(
      [sevenDay(60), fiveHour(90), fable(40)],
      [
        { scope: 'model', modelKey: 'claude-fable-5-1', untilMs: until },
        { scope: 'model', modelKey: 'claude-opus-5-5', untilMs: until },
      ]
    );
    expect(fableLane).toMatchObject({ status: 'closed', reopenAtMs: until });
    expect(fableLane.pause?.modelKey).toBe('claude-fable-5-1');
    // Its own limit is not empty, so the lane still reads it.
    expect(fableLane.gate.id).toBe('seven-day-fable');
    expect(otherLane.status).toBe('open');
  });

  test("the proxy's credential pause closes every lane; expired pauses are ignored", () => {
    const until = NOW + 90 * MINUTE_MS;
    const { lanes } = lanesOf(
      [sevenDay(60), fiveHour(90), fable(40)],
      [
        { scope: 'credential', modelKey: null, untilMs: until },
        { scope: 'credential', modelKey: null, untilMs: NOW - MINUTE_MS },
      ]
    );
    for (const lane of lanes) {
      expect(lane).toMatchObject({ status: 'closed', reopenAtMs: until });
    }
    const expired = lanesOf(
      [sevenDay(60), fiveHour(90), fable(60)],
      [{ scope: 'credential', modelKey: null, untilMs: NOW - MINUTE_MS }]
    );
    expect(expired.lanes.every((lane) => lane.status === 'open')).toBe(true);
  });

  test('a lane without a figure for its own limit is unknown, not open', () => {
    const { fableLane } = lanesOf([sevenDay(60), fiveHour(90), fable(null)]);
    expect(fableLane.status).toBe('unknown');
  });

  test('without an account-wide window there is no other-models lane', () => {
    const { lanes } = lanesOf([fable(60)]);
    expect(lanes.map((lane) => lane.id)).toEqual(['seven-day-fable']);
  });
});

describe('lane columns', () => {
  test('model lanes in first-seen order, then the rest; unloaded rows skipped', () => {
    const sonnet = { ...fable(50), id: 'seven-day-sonnet', model: 'Sonnet' };
    const columns = buildLaneColumns([
      snapshot([sevenDay(60), fable(40)]),
      null,
      snapshot([sevenDay(60), sonnet, fable(40)]),
    ]);
    expect(columns).toEqual([
      { id: 'seven-day-fable', model: 'Fable' },
      { id: 'seven-day-sonnet', model: 'Sonnet' },
      { id: OTHER_MODELS_LANE_ID, model: null },
    ]);
  });

  test('only a scoped window with a model makes a lane', () => {
    expect(hasModelLanes(snapshot([sevenDay(60), fable(40)]))).toBe(true);
    expect(hasModelLanes(snapshot([sevenDay(60), { ...fable(40), model: null }]))).toBe(false);
    expect(hasModelLanes(snapshot([sevenDay(60)]))).toBe(false);
    expect(hasModelLanes(null)).toBe(false);
  });
});

describe('credential availability', () => {
  const tokenExpired: CredentialBlock = { reason: 'unavailable', message: 'token expired' };
  const authFile = (overrides: Partial<AuthFileItem>): AuthFileItem => ({
    name: 'claude-a.json',
    type: 'claude',
    ...overrides,
  });

  test('an unavailable credential without a pause is blocked, with its message', () => {
    expect(
      credentialBlockFromAuthFile(
        authFile({ unavailable: true, status: 'error', status_message: 'token expired' }),
        []
      )
    ).toEqual(tokenExpired);
    // A healthy-sounding message is not worth repeating.
    expect(
      credentialBlockFromAuthFile(authFile({ unavailable: true, statusMessage: 'ok' }), [])
    ).toEqual({ reason: 'unavailable', message: null });
  });

  test('a disabled credential is blocked', () => {
    expect(credentialBlockFromAuthFile(authFile({ disabled: true }), [])).toEqual({
      reason: 'disabled',
      message: null,
    });
    expect(credentialBlockFromAuthFile(authFile({ status: ' DISABLED ' }), [])).toEqual({
      reason: 'disabled',
      message: null,
    });
  });

  test('a credential-wide cooldown explains unavailable: it shows as a pause instead', () => {
    const pause: LedgerPause = { scope: 'credential', modelKey: null, untilMs: NOW + HOUR_MS };
    expect(
      credentialBlockFromAuthFile(authFile({ unavailable: true, status: 'error' }), [pause])
    ).toBeNull();
  });

  test('only the flags the selector honours block a credential', () => {
    expect(credentialBlockFromAuthFile(authFile({ status: 'active' }), [])).toBeNull();
    // The list reconciles status against the selector; error without unavailable still serves.
    expect(credentialBlockFromAuthFile(authFile({ status: 'error' }), [])).toBeNull();
    expect(
      credentialBlockFromAuthFile(authFile({ statusMessage: 'refresh token rejected' }), [])
    ).toBeNull();
  });

  test('a blocked credential has no open lane, but keeps its cached quota visible', () => {
    const lanes = buildQuotaLanes(
      { ...snapshot([sevenDay(80), fiveHour(90), fable(70)]), block: tokenExpired },
      NOW
    );
    expect(lanes.map((lane) => lane.status)).toEqual(['unavailable', 'unavailable']);
    for (const lane of lanes) {
      expect(lane).toMatchObject({ block: tokenExpired, reopenAtMs: null, runoutAtMs: null });
      expect(lane.gate).toBe(lane.own);
    }
    expect(lanes[0].gate.remaining).toBe(70);
  });

  test('a blocked credential does not count as serving in the summary', () => {
    const healthy = snapshot([sevenDay(80), fiveHour(90), fable(70)], []);
    const summary = summarizeProvider([healthy, { ...healthy, block: tokenExpired }], NOW);
    expect(summary.models[0]).toMatchObject({ carrying: 2, serving: 1 });
    // The cached quota still pools as information.
    expect(summary.models[0].line.totalRemaining).toBe(140);
  });
});

describe('ledgerPausesFromCooldowns', () => {
  test('anchors each active cooldown to when the list arrived', () => {
    const receivedAtMs = NOW - 10_000;
    expect(
      ledgerPausesFromCooldowns({
        receivedAtMs,
        records: [
          {
            scope: 'model',
            modelKey: 'claude-fable-5-1',
            reason: 'quota',
            retryAt: '',
            remainingSeconds: 120,
          },
          { scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: 30 },
          { scope: 'model', modelKey: 'gone', reason: 'quota', retryAt: '', remainingSeconds: 0 },
        ],
      })
    ).toEqual([
      { scope: 'model', modelKey: 'claude-fable-5-1', untilMs: receivedAtMs + 120_000 },
      { scope: 'credential', modelKey: null, untilMs: receivedAtMs + 30_000 },
    ]);
  });

  test('unknown or missing runtime state means no pauses', () => {
    expect(ledgerPausesFromCooldowns(undefined)).toEqual([]);
    expect(ledgerPausesFromCooldowns({ receivedAtMs: NOW, records: null })).toEqual([]);
  });
});

test('projected instants round to the nearest ten minutes', () => {
  const base = new Date(2026, 9, 7, 4, 0).getTime();
  expect(approximateInstant(base + 4 * MINUTE_MS)).toBe(base);
  expect(approximateInstant(base + 6 * MINUTE_MS)).toBe(base + 10 * MINUTE_MS);
});
