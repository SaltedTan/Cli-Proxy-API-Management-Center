/**
 * A key's 7-day window that ends between polls. The backend stops counting the key's
 * usage against it at that instant and opens the next one with the key's next Claude
 * request, so the panel must stop claiming "Limit reached" with the old usage.
 */

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { ClientUsagePanel } from '@/features/dashboard/components/ClientUsagePanel';
import {
  buildClientUsageRows,
  claudeLimitStatus,
  claudeWindowEnded,
  claudeWindowStatus,
  clientUsageServerNow,
} from '@/features/dashboard/clientUsage';
import { normalizeClientUsage } from '@/services/api/clientUsage';
import type {
  ClientKeyClaudeUsage,
  ClientKeyUsage,
  ClientUsageSnapshot,
} from '@/types/clientUsage';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const HOUR = 3_600_000;
const STARTED = Date.parse('2026-10-01T12:00:00Z');
const ENDS = STARTED + 7 * 24 * HOUR;
const BEFORE_END = ENDS - HOUR;
const AFTER_END = ENDS + HOUR;

const noTokens = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

/** A key at its 2 Pro allowance in a window that ends at `ENDS`. */
const reachedClaude = (overrides: Partial<ClientKeyClaudeUsage> = {}): ClientKeyClaudeUsage => ({
  currentProUnits: 2,
  totalProUnits: 3,
  windowStartedAtMs: STARTED,
  windowResetsAtMs: ENDS,
  limitProUnits: 2,
  remainingProUnits: 0,
  limitReached: true,
  limitResetsAtMs: ENDS,
  credentials: [
    {
      authId: 'claude-a.json',
      plan: 'pro',
      planProUnits: 1,
      planSource: 'plan',
      currentFraction: 2,
      currentProUnits: 2,
      totalFraction: 3,
      totalProUnits: 3,
    },
  ],
  ...overrides,
});

const keyWith = (claude: ClientKeyClaudeUsage): ClientKeyUsage => ({
  id: 'ab12ab12ab12ab12',
  name: 'Laptop',
  key: 'fixt...ptop',
  configured: true,
  firstUsedAtMs: STARTED,
  lastUsedAtMs: STARTED + HOUR,
  totals: { requests: 10, failed: 0, blocked: 2, tokens: noTokens() },
  models: [],
  daily: [],
  claude,
});

const rowOptions = (nowMs: number) => ({
  localNames: new Map<string, string>(),
  anonymousLabel: 'anonymous',
  today: '2026-10-08',
  nowMs,
});

const snapshot = (claude: ClientKeyClaudeUsage, receivedAtMs?: number): ClientUsageSnapshot => ({
  generatedAtMs: BEFORE_END,
  receivedAtMs,
  serverDate: '2026-10-08',
  sinceMs: STARTED,
  keys: [keyWith(claude)],
  claudeCredentials: [],
  claudeLimitsSupported: true,
});

const renderAt = (nowMs: number, claude: ClientKeyClaudeUsage, receivedAtMs?: number) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        null,
        createElement(ClientUsagePanel, {
          usage: { status: 'ready', data: snapshot(claude, receivedAtMs) },
          localNames: new Map(),
          onSaveLimit: async () => undefined,
          onResetWindow: async () => undefined,
          nowMs,
        })
      )
    )
  );

describe('a key window that ended since the last snapshot', () => {
  test('is ended only once the current time reaches its end', () => {
    expect(claudeWindowEnded(reachedClaude(), BEFORE_END)).toBe(false);
    expect(claudeWindowEnded(reachedClaude(), ENDS)).toBe(true);
    expect(claudeWindowEnded(reachedClaude(), AFTER_END)).toBe(true);
    // No window reported: nothing to end (never used, idle, or reset).
    expect(claudeWindowEnded(reachedClaude({ windowResetsAtMs: null }), AFTER_END)).toBe(false);
    expect(claudeWindowEnded(null, AFTER_END)).toBe(false);
  });

  test('still reads as reached while the window runs', () => {
    expect(claudeLimitStatus(reachedClaude(), BEFORE_END)).toEqual({
      limit: 2,
      used: 2,
      remaining: 0,
      fraction: 1,
      reached: true,
      resetsAtMs: ENDS,
    });
  });

  test('no longer reads as reached once the window ended, like a key with no window', () => {
    const ended = claudeLimitStatus(reachedClaude(), AFTER_END);
    expect(ended).toEqual({
      limit: 2,
      used: 0,
      remaining: 2,
      fraction: 0,
      reached: false,
      resetsAtMs: null,
    });
    // The backend reports a key whose window closed with no usage and no reset instant.
    const closed = claudeLimitStatus(
      reachedClaude({
        currentProUnits: 0,
        windowStartedAtMs: null,
        windowResetsAtMs: null,
        remainingProUnits: 2,
        limitReached: false,
        limitResetsAtMs: null,
      }),
      AFTER_END
    );
    expect(ended).toEqual(closed);
    expect(claudeWindowStatus(reachedClaude(), AFTER_END)).toBeNull();
  });

  test('keeps an older backend that reports only the credential reset as before', () => {
    const older = reachedClaude({ windowStartedAtMs: null, windowResetsAtMs: null });
    expect(claudeLimitStatus(older, AFTER_END)).toMatchObject({
      used: 2,
      reached: true,
      resetsAtMs: null,
    });
  });

  test('drops the ended window usage from the row, keeping totals', () => {
    const [running] = buildClientUsageRows([keyWith(reachedClaude())], rowOptions(BEFORE_END));
    expect(running.claudeCurrentProUnits).toBe(2);
    expect(running.claudeCredentials[0].currentProUnits).toBe(2);

    const [ended] = buildClientUsageRows([keyWith(reachedClaude())], rowOptions(AFTER_END));
    expect(ended.claudeCurrentProUnits).toBe(0);
    expect(ended.claudeShare).toBeNull();
    expect(ended.claudeWindow).toBeNull();
    expect(ended.claudeLimit?.reached).toBe(false);
    expect(ended.claudeTotalProUnits).toBe(3);
    expect(ended.claudeCredentials[0]).toMatchObject({
      currentFraction: 0,
      currentProUnits: 0,
      totalProUnits: 3,
    });
  });

  test('renders without "Limit reached" or the window reset once the window ended', () => {
    const running = renderAt(BEFORE_END, reachedClaude());
    expect(running).toContain(t('dashboard.client_usage_limit_reached'));
    expect(running).toContain(t('dashboard.client_usage_window_reset'));

    const ended = renderAt(AFTER_END, reachedClaude());
    expect(ended).not.toContain(t('dashboard.client_usage_limit_reached'));
    expect(ended).not.toContain(t('dashboard.client_usage_window_reset'));
    expect(ended).toContain(
      t('dashboard.client_usage_limit_meter', { used: '0.00', limit: '2.00' })
    );
  });
});

describe('a key window judged against a skewed browser clock', () => {
  // The server generated the snapshot an hour before the window ends; the browser clock
  // runs two hours ahead, so by the browser's clock the window already ended.
  const BROWSER_AHEAD = 2 * HOUR;
  const receivedAt = BEFORE_END + BROWSER_AHEAD;

  test('places the browser time on the server timeline', () => {
    const data = snapshot(reachedClaude(), receivedAt);
    expect(clientUsageServerNow(data, receivedAt)).toBe(BEFORE_END);
    expect(clientUsageServerNow(data, receivedAt + 30 * 60_000)).toBe(BEFORE_END + 30 * 60_000);
    // Without the receipt instant there is nothing to correct with.
    expect(clientUsageServerNow(snapshot(reachedClaude()), receivedAt)).toBe(receivedAt);
  });

  test('records when a read arrived', () => {
    const read = normalizeClientUsage({ generated_at: '2026-10-08T11:00:00Z' }, receivedAt);
    expect(read.receivedAtMs).toBe(receivedAt);
  });

  test('keeps a fresh reached limit until the server window ends', () => {
    const fresh = renderAt(receivedAt, reachedClaude(), receivedAt);
    expect(fresh).toContain(t('dashboard.client_usage_limit_reached'));
    expect(fresh).toContain(
      t('dashboard.client_usage_limit_meter', { used: '2.00', limit: '2.00' })
    );

    // Two server hours later the window has ended on the server's clock too.
    const later = renderAt(receivedAt + 2 * HOUR, reachedClaude(), receivedAt);
    expect(later).not.toContain(t('dashboard.client_usage_limit_reached'));
  });
});
