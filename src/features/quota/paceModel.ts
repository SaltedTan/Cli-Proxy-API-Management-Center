/**
 * Pace: is a quota window being spent faster or slower than its reset clock?
 *
 * Follows quota-axi's model (github.com/kunchenguid/quota-axi): compare the
 * share of the window still left with the share of the cycle still to run. A
 * window with 60% left and 40% of its cycle to go holds 20 points in reserve —
 * under pace; one with 20% left and 40% to go is over pace and, burning at its
 * cycle average, empties before the reset. Over pace and "projected to run out
 * before the reset" are the same condition under a linear projection.
 *
 * Only reported cycles are paced. A window whose length the client had to guess
 * (a "monthly" label read as 30 days) stays unknown: a one-day error over a
 * month already moves the reserve by more than the deadband.
 *
 * Pure and clock-free like ledgerModel.ts: `nowMs` is always passed in.
 */

import { HOUR_MS } from '@/utils/time/durations';
import type { LedgerWindow } from './ledgerModel';

export type PaceStatus = 'over' | 'on' | 'under';

export type PaceUnknownReason =
  'missing_usage' | 'missing_cycle' | 'expired_reset' | 'invalid_cycle';

export interface KnownPace {
  status: PaceStatus;
  /** Share of the cycle already elapsed, 0..100. */
  elapsedPercent: number;
  /** Remaining percent an even spend would show now — where the meter's pace mark sits. */
  expectedRemaining: number;
  /** remaining − expectedRemaining, in percentage points; negative is over pace. */
  reservePoints: number;
  /** Cycle-average projection of when the window empties; null when it lasts to the reset. */
  exhaustedAtMs: number | null;
  /** Too little of the cycle has elapsed for the projection to mean much. */
  early: boolean;
}

export type WindowPace = KnownPace | { status: 'unknown'; reason: PaceUnknownReason };

/** Reserve within ± this many points reads as on pace — absorbs API rounding. */
export const PACE_DEADBAND_POINTS = 1;

/** Below this elapsed share the projection is marked early (one request can dominate it). */
export const PACE_EARLY_PERCENT = 10;

/**
 * A reset may sit marginally more than one period away (second-level rounding
 * in the payload). Further than this and the reported cycle is inconsistent.
 */
const CYCLE_TOLERANCE = 0.01;

export type PaceInput = Pick<
  LedgerWindow,
  'remaining' | 'resetAtMs' | 'periodHours' | 'periodEstimated'
>;

export function computeWindowPace(window: PaceInput, nowMs: number): WindowPace {
  if (window.remaining === null) return { status: 'unknown', reason: 'missing_usage' };
  const { periodHours, resetAtMs } = window;
  if (resetAtMs === null || periodHours === null || periodHours <= 0 || window.periodEstimated) {
    return { status: 'unknown', reason: 'missing_cycle' };
  }

  const cycleMs = periodHours * HOUR_MS;
  const untilResetMs = resetAtMs - nowMs;
  if (untilResetMs <= 0) return { status: 'unknown', reason: 'expired_reset' };
  if (untilResetMs > cycleMs * (1 + CYCLE_TOLERANCE)) {
    return { status: 'unknown', reason: 'invalid_cycle' };
  }

  const leftMs = Math.min(untilResetMs, cycleMs);
  const elapsedMs = cycleMs - leftMs;
  const expectedRemaining = (leftMs / cycleMs) * 100;
  const remaining = window.remaining;
  const reservePoints = remaining - expectedRemaining;
  const status: PaceStatus =
    Math.abs(reservePoints) <= PACE_DEADBAND_POINTS ? 'on' : reservePoints < 0 ? 'over' : 'under';

  const used = 100 - remaining;
  let exhaustedAtMs: number | null = null;
  if (remaining <= 0) {
    exhaustedAtMs = nowMs;
  } else if (used > 0 && elapsedMs > 0) {
    const projected = nowMs + (remaining * elapsedMs) / used;
    if (projected < resetAtMs) exhaustedAtMs = projected;
  }

  const elapsedPercent = 100 - expectedRemaining;
  return {
    status,
    elapsedPercent,
    expectedRemaining,
    reservePoints,
    exhaustedAtMs,
    early: elapsedPercent < PACE_EARLY_PERCENT,
  };
}

export interface PaceCounts {
  over: number;
  on: number;
  under: number;
}
