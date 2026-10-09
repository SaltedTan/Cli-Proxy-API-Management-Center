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

const snapshot = (windows: LedgerWindow[], pauses?: LedgerPause[] | null): LedgerSnapshot => ({
  plan: 'Max 5x',
  windows,
  ...(pauses !== undefined ? { pauses } : {}),
});

const lanesOf = (windows: LedgerWindow[], pauses?: LedgerPause[] | null) => {
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

  test('a model pause outside every model lane makes the other-models lane partial', () => {
    const until = NOW + 4 * HOUR_MS;
    const { fableLane, otherLane } = lanesOf(
      [sevenDay(60), fiveHour(90), fable(60)],
      [{ scope: 'model', modelKey: 'claude-sonnet-4-5', untilMs: until }]
    );
    expect(otherLane).toMatchObject({ status: 'partial', pause: null, reopenAtMs: null });
    expect(otherLane.modelPauses).toEqual([
      { scope: 'model', modelKey: 'claude-sonnet-4-5', untilMs: until },
    ]);
    // The lane still reads its quota; the pause restricts one model id only.
    expect(otherLane.gate.id).toBe('seven-day');
    expect(fableLane).toMatchObject({ status: 'open', modelPauses: [] });
  });

  test("a model pause restricts its own id, never the whole of a model's lane", () => {
    // Another Fable version is paused; the lane is "Fable 5.1".
    const until = NOW + 4 * DAY_MS;
    const { fableLane, otherLane } = lanesOf(
      [sevenDay(60), fiveHour(90), { ...fable(40), model: 'Fable 5.1' }],
      [{ scope: 'model', modelKey: 'claude-fable-5-0', untilMs: until }]
    );
    expect(fableLane).toMatchObject({ status: 'partial', reopenAtMs: null });
    expect(fableLane.modelPauses.map((pause) => pause.modelKey)).toEqual(['claude-fable-5-0']);
    expect(fableLane.gate.id).toBe('seven-day-fable');
    // A Fable id belongs to the Fable lane, not to every other model.
    expect(otherLane).toMatchObject({ status: 'open', modelPauses: [] });
  });

  test('model pauses match whole words of the id, soonest lift first, expired ones dropped', () => {
    const { fableLane, otherLane } = lanesOf(
      [sevenDay(60), fiveHour(90), fable(40)],
      [
        { scope: 'model', modelKey: 'claude-fable-5-1', untilMs: NOW + 2 * HOUR_MS },
        { scope: 'model', modelKey: 'claude-fable-5-0', untilMs: NOW + HOUR_MS },
        { scope: 'model', modelKey: 'claude-fable-4-0', untilMs: NOW - MINUTE_MS },
        { scope: 'model', modelKey: 'claude-fableish-1', untilMs: NOW + HOUR_MS },
      ]
    );
    expect(fableLane.modelPauses.map((pause) => pause.modelKey)).toEqual([
      'claude-fable-5-0',
      'claude-fable-5-1',
    ]);
    expect(otherLane.modelPauses.map((pause) => pause.modelKey)).toEqual(['claude-fableish-1']);
  });

  test('a partial lane keeps its projection, and a closed one stays closed', () => {
    const pause: LedgerPause = {
      scope: 'model',
      modelKey: 'claude-fable-5-1',
      untilMs: NOW + HOUR_MS,
    };
    const short = lanesOf([sevenDay(80), fiveHour(90), fable(10)], [pause]).fableLane;
    expect(short.status).toBe('partial');
    expect(short.runoutAtMs).not.toBeNull();
    const empty = lanesOf([sevenDay(80), fiveHour(90), fable(0)], [pause]).fableLane;
    expect(empty.status).toBe('closed');
    // The gate decides when the lane reopens, not the pause on one id.
    expect(empty.reopenAtMs).toBe(WEEKLY_RESET);
  });

  test('partial lanes do not count as serving', () => {
    const windows = [sevenDay(80), fiveHour(90), fable(70)];
    const summary = summarizeProvider(
      [
        snapshot(windows, []),
        snapshot(windows, [
          { scope: 'model', modelKey: 'claude-fable-5-1', untilMs: NOW + HOUR_MS },
        ]),
      ],
      NOW
    );
    expect(summary.models[0]).toMatchObject({ carrying: 2, serving: 1, partial: 1 });
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

  test('an unknown account-wide gate leaves a lane unknown, not open', () => {
    // Fable reads 70%, but nobody knows whether the 7-day limit is empty.
    const { fableLane, otherLane } = lanesOf([sevenDay(null), fiveHour(90), fable(70)]);
    expect(fableLane.status).toBe('unknown');
    expect(fableLane.gate.id).toBe('seven-day');
    expect(otherLane.status).toBe('unknown');
  });

  test('an unknown gate does not hide one that is known to be empty', () => {
    const { lanes } = lanesOf([sevenDay(null), fiveHour(0), fable(70)]);
    expect(lanes.map((lane) => lane.status)).toEqual(['closed', 'closed']);
  });

  test('unreported pauses leave every lane unknown, unless a known gate closes it', () => {
    const { lanes } = lanesOf([sevenDay(80), fiveHour(90), fable(70)], null);
    for (const lane of lanes) {
      expect(lane).toMatchObject({ status: 'unknown', pausesUnknown: true });
      expect(lane.gate).toBe(lane.own);
    }
    const empty = lanesOf([sevenDay(80), fiveHour(90), fable(0)], null);
    expect(empty.fableLane.status).toBe('closed');
    expect(empty.otherLane.status).toBe('unknown');
    // Reported, with nothing active: the lanes read their quota.
    expect(lanesOf([sevenDay(80), fiveHour(90), fable(70)], []).fableLane).toMatchObject({
      status: 'open',
      pausesUnknown: false,
    });
  });

  test('unknown lanes never count as serving', () => {
    const summary = summarizeProvider(
      [
        snapshot([sevenDay(80), fiveHour(90), fable(70)], []),
        snapshot([sevenDay(80), fiveHour(90), fable(70)], null),
        snapshot([sevenDay(null), fiveHour(90), fable(70)], []),
      ],
      NOW
    );
    expect(summary.models[0]).toMatchObject({ carrying: 3, serving: 1, unknown: 2 });
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

  test('an unavailable credential is blocked when the pauses are unknown', () => {
    expect(credentialBlockFromAuthFile(authFile({ unavailable: true }), null)).toEqual({
      reason: 'unavailable',
      message: null,
    });
  });

  test('a credential-wide cooldown explains unavailable: it shows as a pause instead', () => {
    const pause: LedgerPause = { scope: 'credential', modelKey: null, untilMs: NOW + HOUR_MS };
    expect(
      credentialBlockFromAuthFile(authFile({ unavailable: true, status: 'error' }), [pause])
    ).toBeNull();
  });

  test('model cooldowns behind the aggregate flag hold only their own lanes', () => {
    // Only Opus has a recorded state, and it is cooling: the proxy marks the credential
    // unavailable, yet still selects it for Sonnet.
    const opus: LedgerPause = {
      scope: 'model',
      modelKey: 'claude-opus-4-6',
      untilMs: NOW + HOUR_MS,
    };
    const aggregate = authFile({
      unavailable: true,
      status: 'error',
      status_message: 'rate limited',
      next_retry_after: new Date(NOW + HOUR_MS).toISOString(),
    });
    const block = credentialBlockFromAuthFile(aggregate, [opus]);
    expect(block).toBeNull();
    const opusWindow: LedgerWindow = {
      ...sevenDay(60),
      id: 'seven-day-opus',
      label: 'Opus',
      scope: 'scoped',
      model: 'Opus',
    };
    const lanes = buildQuotaLanes(
      { plan: null, windows: [sevenDay(60), opusWindow], pauses: [opus], block },
      NOW
    );
    expect(lanes.map((lane) => [lane.id, lane.status])).toEqual([
      ['seven-day-opus', 'partial'],
      [OTHER_MODELS_LANE_ID, 'open'],
    ]);

    // Terminal failures still block every model, model cooldowns or not.
    // An unauthorized credential reports no retry deadline.
    expect(
      credentialBlockFromAuthFile({ ...aggregate, next_retry_after: undefined }, [opus])?.reason
    ).toBe('unavailable');
    expect(
      credentialBlockFromAuthFile({ ...aggregate, status_message: 'token expired' }, [opus])
    ).toEqual(tokenExpired);
    expect(
      credentialBlockFromAuthFile({ ...aggregate, refreshError: { message: 'refresh failed' } }, [
        opus,
      ])?.reason
    ).toBe('unavailable');
  });

  describe('when the list says why it is unavailable', () => {
    const opus: LedgerPause = {
      scope: 'model',
      modelKey: 'claude-opus-4-6',
      untilMs: NOW + HOUR_MS,
    };
    const credentialPause: LedgerPause = {
      scope: 'credential',
      modelKey: null,
      untilMs: NOW + HOUR_MS,
    };
    // What the proxy lists for a credential with Opus cooling: the aggregate retry
    // deadline and the cooldown's message, whatever else is wrong with it.
    const opusCooling = authFile({
      unavailable: true,
      status: 'error',
      status_message: 'upstream request failed',
      next_retry_after: new Date(NOW + HOUR_MS).toISOString(),
    });
    const opusWindow: LedgerWindow = {
      ...sevenDay(60),
      id: 'seven-day-opus',
      label: 'Opus',
      scope: 'scoped',
      model: 'Opus',
    };
    const laneStatuses = (block: CredentialBlock | null) =>
      buildQuotaLanes(
        { plan: null, windows: [sevenDay(60), opusWindow], pauses: [opus], block },
        NOW
      ).map((lane) => [lane.id, lane.status]);

    test('an expired token blocks every lane, though the model cooldown left a deadline', () => {
      // The token's expiry is not in the message, and the refresh has not failed yet.
      const block = credentialBlockFromAuthFile(
        { ...opusCooling, unavailable_reason: 'auth' },
        [opus]
      );
      expect(block).toEqual({ reason: 'unavailable', message: 'upstream request failed' });
      expect(laneStatuses(block)).toEqual([
        ['seven-day-opus', 'unavailable'],
        [OTHER_MODELS_LANE_ID, 'unavailable'],
      ]);
      // A credential-wide pause ends, the auth failure does not.
      expect(
        credentialBlockFromAuthFile({ ...opusCooling, unavailable_reason: 'auth' }, [
          credentialPause,
        ])?.reason
      ).toBe('unavailable');
    });

    test('a failing refresh of a still-valid token leaves the other models open', () => {
      const file: AuthFileItem = {
        ...opusCooling,
        unavailable_reason: 'models',
        refreshError: { message: 'token refresh failed: status 503', httpStatus: 503 },
      };
      const block = credentialBlockFromAuthFile(file, [opus]);
      expect(block).toBeNull();
      expect(laneStatuses(block)).toEqual([
        ['seven-day-opus', 'partial'],
        [OTHER_MODELS_LANE_ID, 'open'],
      ]);
      // Model cooldowns never block the credential, even with a terminal-sounding
      // message or when the pauses are unknown.
      expect(
        credentialBlockFromAuthFile({ ...file, status_message: 'token expired' }, [opus])
      ).toBeNull();
      expect(credentialBlockFromAuthFile(file, null)).toBeNull();
    });

    test('a credential-wide cooldown shows as its pause, or blocks without one', () => {
      const file: AuthFileItem = { ...opusCooling, unavailable_reason: 'cooldown' };
      expect(credentialBlockFromAuthFile(file, [credentialPause, opus])).toBeNull();
      // Model pauses do not explain a credential-wide cooldown.
      expect(credentialBlockFromAuthFile(file, [opus])?.reason).toBe('unavailable');
    });

    test('without a reason, the deadline, message and refresh state still decide', () => {
      expect(credentialBlockFromAuthFile(opusCooling, [opus])).toBeNull();
      expect(
        credentialBlockFromAuthFile({ ...opusCooling, refreshError: { message: 'failed' } }, [
          opus,
        ])?.reason
      ).toBe('unavailable');
      // An unrecognised reason is treated as absent.
      expect(
        credentialBlockFromAuthFile(
          { ...opusCooling, unavailable_reason: 'other' as AuthFileItem['unavailable_reason'] },
          [opus]
        )
      ).toBeNull();
    });
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

  test('unknown or missing runtime state stays unknown, apart from no pauses', () => {
    expect(ledgerPausesFromCooldowns(undefined)).toBeNull();
    expect(ledgerPausesFromCooldowns({ receivedAtMs: NOW, records: null })).toBeNull();
    expect(ledgerPausesFromCooldowns({ receivedAtMs: NOW, records: [] })).toEqual([]);
  });
});

test('projected instants round to the nearest ten minutes', () => {
  const base = new Date(2026, 9, 7, 4, 0).getTime();
  expect(approximateInstant(base + 4 * MINUTE_MS)).toBe(base);
  expect(approximateInstant(base + 6 * MINUTE_MS)).toBe(base + 10 * MINUTE_MS);
});
