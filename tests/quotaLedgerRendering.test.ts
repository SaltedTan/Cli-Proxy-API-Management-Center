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
import en from '@/i18n/locales/en.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';
import vi from '@/i18n/locales/vi.json';
import ko from '@/i18n/locales/ko.json';

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

  test("gives a model's own limit a block that says how many credentials can serve it", () => {
    const reset = NOW + 3 * DAY_MS;
    const credential = (fable: number) => ({
      plan: 'Max 5x',
      windows: [
        { ...window('weekly', 80, 168), label: '7-day limit', scope: 'account' as const },
        {
          id: 'fable',
          label: '7-day Fable',
          remaining: fable,
          resetAtMs: reset,
          resetLabel: null,
          periodHours: 168,
          scope: 'scoped' as const,
          model: 'Fable',
        },
      ],
    });
    const summary = summarizeProvider([credential(70), credential(0)], NOW);
    const markup = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [{ provider: 'claude', summary }],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    // The account-wide limit headlines; Fable gets its own block, not a folded line.
    expect(markup.indexOf('7-day limit')).toBeLessThan(markup.indexOf('7-day Fable'));
    expect(markup).toContain('70%');
    expect(markup).toContain('of 200%');
    expect(markup).toContain('1 of 2 can serve now');
    expect(markup).toContain('None projected to run out before refill');
    expect(markup.match(/role="img"/g)).toHaveLength(2);
    expect(markup).not.toContain('aria-expanded');

    // 10% left with four of seven days gone: projected to stop before the refill.
    const short = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [{ provider: 'claude', summary: summarizeProvider([credential(10)], NOW) }],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    expect(short).toContain('1 of 1 can serve now');

    // Unreported pauses: unknown is neither serving nor paused.
    const unknown = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [
          {
            provider: 'claude',
            summary: summarizeProvider([{ ...credential(70), pauses: null }], NOW),
          },
        ],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    expect(unknown).toContain('0 of 1 can serve now · 1 unknown');

    // A paused model id: partial, neither serving nor closed.
    const partial = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [
          {
            provider: 'claude',
            summary: summarizeProvider(
              [
                {
                  ...credential(70),
                  pauses: [{ scope: 'model', modelKey: 'claude-fable-5-1', untilMs: NOW + DAY_MS }],
                },
                credential(70),
              ],
              NOW
            ),
          },
        ],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    expect(partial).toContain('1 of 2 can serve now · 1 partly paused');
    expect(short).toMatch(/1 of 1 run out before refill · first ~\S+ \d\d:\d0/);
  });

  test('counts credentials the proxy will not select on a line of their own', () => {
    const summary = summarizeProvider([null, null], NOW);
    const render = (unavailable?: number) =>
      renderToStaticMarkup(
        createElement(QuotaSummaryStrip, {
          groups: [{ provider: 'claude', summary, unavailable }],
          resolvedTheme: 'light',
          now: NOW,
        })
      );
    expect(render(2)).toContain('2 credentials unavailable to the proxy');
    expect(render(0)).not.toContain('unavailable to the proxy');
    expect(render()).not.toContain('unavailable to the proxy');
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

  test('model lanes are titled for assistive tech and collapse in narrow containers', () => {
    expect(ledger).toContain('buildQuotaLanes(snapshot, now)');
    expect(ledger).toContain('<LaneHeadRow columns={laneColumns} />');
    expect(ledger).toContain('aria-hidden="true"');
    expect(ledger).toContain('<span className={styles.laneTitle}>{title}</span>');
    expect(ledger).toContain('aria-labelledby={labelId}');
    // Lanes stack below 960px, ahead of the general 720px collapse, so they never get squeezed.
    const middle = ledgerStyles.indexOf('@container (max-width: 960px)');
    const narrow = ledgerStyles.indexOf('@container (max-width: 720px)');
    expect(middle).toBeGreaterThan(-1);
    expect(middle).toBeLessThan(narrow);
    const stacked = ledgerStyles.slice(middle, narrow);
    expect(stacked).toContain('.laneHead {');
    expect(stacked).toContain('.laneTitle {');
    expect(stacked).toContain('.laneRow .identity {');
  });

  test('page joins the proxy pauses and credential availability into ledger snapshots', () => {
    expect(page).toContain('const pauses = ledgerPausesFromCooldowns(entry.file.cooldownSnapshot)');
    expect(page).toContain('block: credentialBlockFromAuthFile(entry.file, pauses)');
  });

  test('ledger rows name a credential the proxy will not select', () => {
    expect(ledger).toContain('credentialBlockFromAuthFile(file, pauses)');
    expect(ledger).toContain("t('quota_management.ledger_unavailable_message'");
    expect(ledger).toContain("t('quota_management.lane_unavailable_note')");
  });

  test('page defaults to the ledger and masks emails until asked', () => {
    expect(page).toContain("readQuotaUiState()?.view ?? 'ledger'");
    expect(page).toContain('readQuotaUiState()?.showEmails ?? false');
    expect(page).toContain('maskEmails={!showEmails}');
  });
});

describe('lane locale keys', () => {
  const KEYS = [
    'ledger_paused_until',
    'ledger_limits_label',
    'lane_other_models',
    'lane_status_open',
    'lane_status_tight',
    'lane_status_closed',
    'lane_status_unknown',
    'lane_status_unavailable',
    'lane_unavailable_note',
    'lane_pauses_unknown',
    'summary_partial',
    'summary_unknown',
    'lane_status_partial',
    'ledger_disabled',
    'ledger_unavailable',
    'ledger_unavailable_message',
    'lane_runs_out_before',
    'lane_used_up',
    'lane_lasts',
    'lane_refills',
    'lane_then_refills',
    'lane_runs_out',
    'lane_back',
    'lane_no_limit',
    'lane_model_paused',
    'summary_serving',
    'summary_runs_short',
    'summary_none_short',
  ] as const;

  for (const [locale, messages] of Object.entries({ en, 'zh-CN': zhCN, 'zh-TW': zhTW, ru, vi, ko })) {
    test(`${locale} translates every lane and model-block string`, () => {
      const quota = messages.quota_management as Record<string, string>;
      expect(KEYS.filter((key) => !quota[key])).toEqual([]);
      expect(messages.claude_quota.seven_day_model).toContain('{{model}}');
      expect('seven_day_fable' in messages.claude_quota).toBe(false);
    });
  }
});
