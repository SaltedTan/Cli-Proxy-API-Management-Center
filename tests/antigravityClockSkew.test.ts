/**
 * Antigravity under clock skew: the card counts down against the upstream's
 * clock, so the ledger, summary and pace must measure the same countdown.
 */

import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import { summarizeProvider } from '@/features/quota/ledgerModel';
import { computeWindowPace } from '@/features/quota/paceModel';
import { buildAntigravityLedger } from '@/features/quota/providers/antigravity/ledger';
import type { AntigravityQuotaState } from '@/types';
import { HOUR_MS } from '@/utils/time/durations';

const t = i18n.t.bind(i18n) as TFunction;

/** The browser runs an hour behind the upstream. */
const OFFSET_MS = HOUR_MS;
const BROWSER_NOW = new Date(2026, 9, 9, 12).getTime();
const SERVER_NOW = BROWSER_NOW + OFFSET_MS;

/** A 5-hour bucket, half spent, resetting two hours from now on the upstream's clock. */
const quota = (serverTimeOffsetMs: number | null): AntigravityQuotaState => ({
  status: 'success',
  serverTimeOffsetMs,
  groups: [
    {
      id: 'gemini',
      label: 'Gemini models',
      buckets: [
        {
          id: 'session',
          label: '5-hour limit',
          remainingFraction: 0.5,
          resetAtMs: SERVER_NOW + 2 * HOUR_MS,
          periodHours: 5,
        },
      ],
    },
  ],
});

describe('Antigravity ledger under clock skew', () => {
  test('the ledger counts down to the same reset as the card', () => {
    const [window] = buildAntigravityLedger(quota(OFFSET_MS), t).windows;
    // AntigravityQuotaBody: reset − (Date.now() + serverTimeOffsetMs).
    const cardRemainingMs = SERVER_NOW + 2 * HOUR_MS - (BROWSER_NOW + OFFSET_MS);
    expect((window.resetAtMs as number) - BROWSER_NOW).toBe(cardRemainingMs);
  });

  test('pace reads the server-corrected cycle: half left with 40% of it to go is under pace', () => {
    const [window] = buildAntigravityLedger(quota(OFFSET_MS), t).windows;
    expect(computeWindowPace(window, BROWSER_NOW).status).toBe('under');
    // Uncorrected, the browser would see three hours to go — 60% — and call it over pace.
    const [skewed] = buildAntigravityLedger(quota(null), t).windows;
    expect(computeWindowPace(skewed, BROWSER_NOW).status).toBe('over');
  });

  test('the summary names the corrected reset and tallies the corrected pace', () => {
    const snapshot = buildAntigravityLedger(quota(OFFSET_MS), t);
    const summary = summarizeProvider([snapshot], BROWSER_NOW);
    expect(summary.headline?.nextResetMs).toBe(BROWSER_NOW + 2 * HOUR_MS);
    expect(summary.headline?.pace).toEqual({ over: 0, on: 0, under: 1 });
  });

  test('without an offset the reset is read as reported', () => {
    const [window] = buildAntigravityLedger(quota(null), t).windows;
    expect(window.resetAtMs).toBe(SERVER_NOW + 2 * HOUR_MS);
  });
});
