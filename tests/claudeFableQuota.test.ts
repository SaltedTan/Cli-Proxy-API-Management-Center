import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { buildClaudeQuotaWindows } from '@/features/quota/providers/claude/data';
import type { ClaudeUsagePayload } from '@/types';
import { formatQuotaResetTime } from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const modernReset = '2026-07-27T10:00:00.000000+00:00';
const legacyReset = '2026-07-28T10:00:00.000000+00:00';

const fableWindow = (usedPercent: number, reset: string, model = 'Fable') => ({
  id: 'seven-day-fable',
  label: 'claude_quota.seven_day_model',
  labelKey: 'claude_quota.seven_day_model',
  labelParams: { model },
  scope: 'scoped',
  model,
  usedPercent,
  resetLabel: formatQuotaResetTime(reset),
  resetAtMs: Date.parse(reset),
  periodHours: 24 * 7,
});

describe('Claude Fable quota', () => {
  test('builds a Fable window from the modern scoped limits payload', () => {
    const windows = buildClaudeQuotaWindows(
      {
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 64,
            resets_at: modernReset,
            is_active: true,
            scope: { model: { id: null, display_name: 'Fable' } },
          },
        ],
      },
      t
    );

    expect(windows).toEqual([fableWindow(64, modernReset)]);
  });

  test('keeps detecting Fable when its display name gains a version', () => {
    const windows = buildClaudeQuotaWindows(
      {
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 30,
            resets_at: modernReset,
            is_active: true,
            scope: { model: { display_name: 'Fable 5.1' } },
          },
        ],
      },
      t
    );

    // The label follows the payload; the id stays put so columns and lanes line up.
    expect(windows).toEqual([fableWindow(30, modernReset, 'Fable 5.1')]);
  });

  test('shows a dollar-denominated legacy field as cloud session credits, not Fable', () => {
    const reset = '2026-11-05T07:59:00+00:00';
    const windows = buildClaudeQuotaWindows(
      {
        iguana_necktie: {
          utilization: 5.043595,
          resets_at: reset,
          limit_dollars: 100,
          used_dollars: 5.043595,
          remaining_dollars: 94.956405,
        },
        limits: [
          { kind: 'session', percent: 10, resets_at: modernReset, is_active: true, scope: null },
          { kind: 'weekly_all', percent: 9, resets_at: legacyReset, is_active: false, scope: null },
        ],
      },
      t
    );

    expect(windows).toEqual([
      {
        id: 'cloud-session-credits',
        label: 'claude_quota.cloud_session_credits',
        labelKey: 'claude_quota.cloud_session_credits',
        scope: 'scoped',
        usedPercent: 5.043595,
        resetLabel: formatQuotaResetTime(reset),
        resetAtMs: Date.parse(reset),
        periodHours: null,
      },
    ]);
  });

  test('shows both cloud session credits and the scoped Fable limit', () => {
    const windows = buildClaudeQuotaWindows(
      {
        iguana_necktie: {
          utilization: 5,
          resets_at: '2026-11-05T07:59:00+00:00',
          limit_dollars: 100,
          used_dollars: 5,
        },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 64,
            resets_at: modernReset,
            is_active: true,
            scope: { model: { id: null, display_name: 'Fable' } },
          },
        ],
      },
      t
    );

    expect(windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['cloud-session-credits', 5],
      ['seven-day-fable', 64],
    ]);
  });

  test('treats a legacy field with only remaining_dollars as cloud session credits', () => {
    const windows = buildClaudeQuotaWindows(
      {
        iguana_necktie: {
          utilization: 5,
          resets_at: '2026-11-05T07:59:00+00:00',
          remaining_dollars: 95,
        },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 64,
            resets_at: modernReset,
            is_active: true,
            scope: { model: { id: null, display_name: 'Fable' } },
          },
        ],
      },
      t
    );

    expect(windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['cloud-session-credits', 5],
      ['seven-day-fable', 64],
    ]);
  });

  test('falls back to the legacy Fable field', () => {
    const windows = buildClaudeQuotaWindows(
      {
        iguana_necktie: {
          utilization: 41,
          resets_at: legacyReset,
        },
      },
      t
    );

    expect(windows).toEqual([fableWindow(41, legacyReset)]);
  });

  test('falls back to the legacy field when the modern percent is invalid', () => {
    const windows = buildClaudeQuotaWindows(
      {
        iguana_necktie: {
          utilization: 41,
          resets_at: legacyReset,
        },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: null,
            resets_at: modernReset,
            is_active: true,
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      },
      t
    );

    expect(windows).toEqual([fableWindow(41, legacyReset)]);
  });

  test('prefers the active modern field without rendering a duplicate', () => {
    const windows = buildClaudeQuotaWindows(
      {
        iguana_necktie: {
          utilization: 41,
          resets_at: legacyReset,
        },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 12,
            resets_at: legacyReset,
            is_active: false,
            scope: { model: { display_name: 'Fable 5' } },
          },
          {
            kind: 'weekly_scoped',
            percent: 64,
            resets_at: modernReset,
            is_active: true,
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      },
      t
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: 'seven-day-fable',
      usedPercent: 64,
      resetLabel: formatQuotaResetTime(modernReset),
    });
  });

  test('uses a valid modern candidate when the preferred candidate is invalid', () => {
    const windows = buildClaudeQuotaWindows(
      {
        limits: [
          {
            kind: 'weekly_scoped',
            percent: null,
            resets_at: legacyReset,
            is_active: true,
            scope: { model: { display_name: 'Fable' } },
          },
          {
            kind: 'weekly_scoped',
            percent: 64,
            resets_at: modernReset,
            is_active: false,
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      },
      t
    );

    expect(windows).toEqual([fableWindow(64, modernReset)]);
  });

  test('ignores malformed and non-weekly limits while preserving standard windows', () => {
    const payload = {
      five_hour: { utilization: 10, resets_at: null },
      seven_day: { utilization: 20, resets_at: legacyReset },
      limits: [
        null,
        { kind: 'session', percent: 50, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 50, scope: { model: { display_name: '  ' } } },
        { kind: 'weekly_scoped', percent: 50, scope: null },
      ],
    } as unknown as ClaudeUsagePayload;

    const windows = buildClaudeQuotaWindows(payload, t);

    expect(windows.map(({ id, usedPercent, scope }) => ({ id, usedPercent, scope }))).toEqual([
      { id: 'five-hour', usedPercent: 10, scope: 'account' },
      { id: 'seven-day', usedPercent: 20, scope: 'account' },
    ]);
  });

  test('gives every model-scoped weekly limit its own window, superseding the named key', () => {
    const windows = buildClaudeQuotaWindows(
      {
        seven_day: { utilization: 20, resets_at: legacyReset },
        seven_day_sonnet: { utilization: 90, resets_at: legacyReset },
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 35,
            resets_at: modernReset,
            scope: { model: { display_name: 'Sonnet 5' } },
          },
          {
            kind: 'WEEKLY_SCOPED',
            percent: 64,
            resets_at: modernReset,
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      },
      t
    );

    expect(
      windows.map(({ id, usedPercent, scope, model }) => ({ id, usedPercent, scope, model }))
    ).toEqual([
      { id: 'seven-day', usedPercent: 20, scope: 'account', model: undefined },
      { id: 'seven-day-sonnet', usedPercent: 35, scope: 'scoped', model: 'Sonnet 5' },
      { id: 'seven-day-fable', usedPercent: 64, scope: 'scoped', model: 'Fable' },
    ]);
  });

  test('marks product-scoped named windows as scoped without a model', () => {
    const windows = buildClaudeQuotaWindows(
      { seven_day_oauth_apps: { utilization: 5, resets_at: legacyReset } },
      t
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: 'seven-day-oauth-apps', scope: 'scoped' });
    expect(windows[0].model).toBeUndefined();
  });
});
