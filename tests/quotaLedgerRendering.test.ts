/**
 * Summary strip markup, plus source contracts for the ledger.
 *
 * QuotaLedger shares QuotaCard's content (and so its class-map binding), which
 * cannot load under bun's empty SCSS modules — the same limitation that keeps
 * QuotaCard out of the rendering suites. Its accessibility and wiring are
 * therefore pinned against source, like the toolbar contracts.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaSummaryStrip } from '@/features/quota/components/QuotaSummaryStrip';
import { summarizeProvider } from '@/features/quota/ledgerModel';
import { DAY_MS } from '@/utils/time/durations';

const NOW = new Date(2026, 8, 10, 12).getTime();

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('QuotaSummaryStrip', () => {
  const window = (id: string, remaining: number, periodHours: number) => ({
    id,
    label: id === 'weekly' ? 'Weekly limit' : '5-hour limit',
    remaining,
    resetAtMs: NOW + DAY_MS,
    resetLabel: null,
    periodHours,
  });

  test('renders the pooled total, one segment per credential and a folded secondary', () => {
    const summary = summarizeProvider(
      [
        { plan: 'Plus', windows: [window('weekly', 17, 168), window('five-hour', 90, 5)] },
        null,
        null,
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
    expect(markup).toContain('aria-label="Quota summary by provider"');
    expect(markup).toContain('3 credentials');
    expect(markup).toContain('Weekly limit');
    expect(markup).toContain('17%');
    expect(markup).toContain('of 300%');
    expect(markup).toContain('in 1 day');
    expect(markup.match(/role="img"/g)).toHaveLength(1);
    expect(markup).toContain('17% of 300% remaining across 3 credentials');
    // Only one secondary window: no disclosure needed.
    expect(markup).toContain('5-hour limit');
    expect(markup).not.toContain('aria-expanded');
  });

  test('says when a provider has nothing loaded yet', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [{ provider: 'kimi', summary: summarizeProvider([null], NOW) }],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    expect(markup).toContain('1 credential');
    expect(markup).toContain('Not loaded yet');
    expect(markup).toContain('--');
  });

  test('renders nothing without providers', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, { groups: [], resolvedTheme: 'light', now: NOW })
    );
    expect(markup).toBe('');
  });
});

describe('ledger source contracts', () => {
  const ledger = readFileSync('src/features/quota/components/QuotaLedger.tsx', 'utf8');
  const ledgerStyles = readFileSync(
    'src/features/quota/components/QuotaLedger.module.scss',
    'utf8'
  );
  const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');

  test('row disclosure is a named, controlled toggle', () => {
    expect(ledger).toContain('aria-expanded={isExpanded}');
    expect(ledger).toContain('aria-controls={detailId}');
    expect(ledger).toContain("'quota_management.ledger_show_details'");
    expect(ledger).toContain('hidden={!isExpanded}');
  });

  test('expanded detail reuses card content without a second refresh action', () => {
    expect(ledger).toContain('<QuotaCardContent');
    expect(ledger).toContain('showRefresh={false}');
  });

  test('loading keeps click-to-fetch and announces progress', () => {
    expect(ledger).toContain('onClick={() => onRefresh(entry)}');
    expect(ledger).toContain('aria-busy="true"');
  });

  test('styles respect reduced motion and collapse in narrow containers', () => {
    expect(ledgerStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(ledgerStyles).toContain('container-type: inline-size');
    expect(ledgerStyles).toContain('@container (max-width: 720px)');
  });

  test('page defaults to the ledger and masks emails until asked', () => {
    expect(page).toContain("readQuotaUiState()?.view ?? 'ledger'");
    expect(page).toContain('readQuotaUiState()?.showEmails ?? false');
    expect(page).toContain('maskEmails={!showEmails}');
  });
});
