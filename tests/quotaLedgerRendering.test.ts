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
import { buildClaudeLedger } from '@/features/quota/providers/claude/ledger';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { ClaudeQuotaState, ClaudeQuotaWindow } from '@/types';
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

  test('counts a subscription out of its 7-day limit as empty in its model block', () => {
    const credential = (weekly: number, fable: number) => ({
      plan: 'Max 20x',
      windows: [
        {
          ...window('weekly', weekly, 168),
          label: '7-day limit',
          scope: 'account' as const,
          resetAtMs: NOW + 2 * DAY_MS,
        },
        {
          id: 'fable',
          label: '7-day Fable',
          remaining: fable,
          resetAtMs: NOW + 3 * DAY_MS,
          resetLabel: null,
          periodHours: 168,
          scope: 'scoped' as const,
          model: 'Fable',
        },
      ],
    });
    const markup = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [
          {
            provider: 'claude',
            summary: summarizeProvider([credential(80, 70), credential(0, 80)], NOW),
          },
        ],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    const fableBlock = markup.slice(markup.indexOf('7-day Fable'));
    // The used-up subscription's 80% Fable is not left: 70% of 200%, not 150%.
    expect(fableBlock).toContain('<span>70%</span>');
    expect(fableBlock).toContain('of 200%');
    expect(fableBlock).toContain('aria-label="70% of 200% remaining across 2 credentials"');
    expect(fableBlock).toMatch(/width:70%.*width:0%/);
    expect(fableBlock).toContain('1 has used up its 7-day limit, counted as empty until it resets');
    expect(fableBlock).toContain('1 of 2 can serve now');
    // Nothing gated, no note.
    const open = renderToStaticMarkup(
      createElement(QuotaSummaryStrip, {
        groups: [{ provider: 'claude', summary: summarizeProvider([credential(80, 70)], NOW) }],
        resolvedTheme: 'light',
        now: NOW,
      })
    );
    expect(open).not.toContain('used up');
  });

  describe('Claude 5-hour pool', () => {
    const claudeWindow = (
      key: string,
      scope: 'account' | 'scoped',
      usedPercent: number,
      periodHours: number,
      resetAtMs = NOW + DAY_MS
    ): ClaudeQuotaWindow => ({
      id: key.replace(/_/g, '-'),
      label: key,
      labelKey: `claude_quota.${key}`,
      scope,
      usedPercent,
      resetLabel: '-',
      resetAtMs,
      periodHours,
    });
    const SESSION_RESET = NOW + 2 * HOUR_MS;
    const claude = (
      planType: string | null,
      session: number | null,
      weekly = true,
      weeklyUsed = 30
    ): ClaudeQuotaState => ({
      status: 'success',
      planType,
      windows: [
        ...(session === null
          ? []
          : [claudeWindow('five_hour', 'account', 100 - session, 5, SESSION_RESET)]),
        ...(weekly
          ? [
              claudeWindow('seven_day', 'account', weeklyUsed, 168),
              claudeWindow('seven_day_oauth_apps', 'scoped', 10, 168),
              claudeWindow('seven_day_cowork', 'scoped', 10, 168),
            ]
          : []),
      ],
    });
    const render = (...quotas: (ClaudeQuotaState | null)[]) =>
      renderToStaticMarkup(
        createElement(QuotaSummaryStrip, {
          groups: [
            {
              provider: 'claude',
              summary: summarizeProvider(
                quotas.map((quota) => (quota ? buildClaudeLedger(quota, i18n.t) : null)),
                NOW
              ),
            },
          ],
          resolvedTheme: 'dark',
          now: NOW,
        })
      );
    /** The 5-hour block's markup, from its label to its unit hint. */
    const sessionBlock = (markup: string) => {
      const start = markup.indexOf('5-hour limit');
      return markup.slice(start, markup.indexOf('In Pro units', start));
    };
    /** The headline's markup, from the cell's top to its unit hint. */
    const headlineBlock = (markup: string) => markup.slice(0, markup.indexOf('In Pro units'));
    const count = (markup: string, text: string) => markup.split(text).length - 1;

    test('reads in Pro sessions, right after the headline and never folded', () => {
      // Pro 30% + Max 5x 50% + Max 20x 90% = 30 + 250 + 1800 of 100 + 500 + 2000.
      const markup = render(
        claude('plan_pro', 30),
        claude('plan_max5', 50),
        claude('plan_max20', 90)
      );
      expect(markup).toContain('2080%');
      expect(markup).toContain('of 2600%');
      expect(markup).toContain('In Pro units: Pro 100% · Team 125% · Max 5x 500% · Max 20x 2000%');
      expect(markup).toContain(
        'aria-label="2080% of 2600% remaining across 3 credentials, in Pro 5-hour units"'
      );
      expect(markup).not.toContain('counted as Pro');
      expect(markup).not.toContain('not loaded yet');
      // Segments are as wide as each credential's share of the pool.
      expect(markup).toContain('style="flex-grow:5"');
      expect(markup).toContain('style="flex-grow:20"');
      // When the pool next grows: the soonest 5-hour reset, not the weekly one.
      expect(sessionBlock(markup)).toContain('in 2 hours');

      const headline = markup.indexOf('7-day limit');
      const session = markup.indexOf('5-hour limit');
      const folded = markup.indexOf('hidden=""');
      expect(headline).toBeGreaterThan(-1);
      expect(session).toBeGreaterThan(headline);
      // The two scoped weekly windows still fold; the session pool is above the toggle.
      expect(markup).toContain('aria-expanded="false"');
      expect(session).toBeLessThan(markup.indexOf('aria-expanded'));
      expect(session).toBeLessThan(folded);
      expect(markup.slice(folded)).not.toContain('5-hour limit');
    });

    test('pools the 7-day headline in Pro weeks, as the proxy does', () => {
      // Pro 70% + Max 5x 50% + Max 20x 10% of their weeks = 70 + 250 + 100 of 100 + 500 + 1000.
      const markup = render(
        claude('plan_pro', 30, true, 30),
        claude('plan_max5', 50, true, 50),
        claude('plan_max20', 90, true, 90)
      );
      const headline = headlineBlock(markup);
      expect(headline).toContain('7-day limit');
      expect(headline).toContain('<span>420%</span>');
      expect(headline).toContain('of 1600%');
      expect(headline).toContain(
        'aria-label="420% of 1600% remaining across 3 credentials, in Pro weekly units"'
      );
      expect(headline).toMatch(
        /flex-grow:5"><span[^>]*width:50%.*flex-grow:10"><span[^>]*width:10%/
      );
      // Each pool names its own scale: the week's Max 20x is 1000%, the session's 2000%.
      expect(markup).toContain('In Pro units: Pro 100% · Team 125% · Max 5x 500% · Max 20x 1000%');
      expect(markup).toContain('In Pro units: Pro 100% · Team 125% · Max 5x 500% · Max 20x 2000%');
      expect(markup.indexOf('Max 20x 1000%')).toBeLessThan(markup.indexOf('5-hour limit'));

      // A used-up week counts as empty and comes back whole at its reset.
      const usedUp = headlineBlock(
        render(claude('plan_pro', 30, true, 30), claude('plan_max20', 100, true, 100))
      );
      expect(usedUp).toContain('<span>70%</span>');
      expect(usedUp).toContain('of 1100%');
      expect(usedUp).toMatch(/flex-grow:10"><span[^>]*width:0%/);
      expect(usedUp).not.toContain('used up');
    });

    test('says how many credentials it counted as Pro for want of a plan', () => {
      const markup = render(
        claude(null, 40),
        claude('plan_max', 40),
        claude('plan_max20', 50),
        null
      );
      // 40 + 40 + 1000 of 100 + 100 + 2000; the unloaded credential is left out.
      expect(markup).toContain('1080%');
      expect(markup).toContain('of 2200%');
      expect(markup).toContain('2 counted as Pro (plan unknown)');
      expect(markup).toContain('across 3 credentials, in Pro 5-hour units');
      expect(markup).toContain('1 not loaded yet, not counted');
    });

    test('draws only the credentials it counts, so the bar matches its capacity', () => {
      const markup = render(claude('plan_pro', 100), null);
      expect(markup).toContain('100%');
      expect(markup).toContain('of 100%');
      const block = sessionBlock(markup);
      expect(block).toContain('across 1 credentials, in Pro 5-hour units');
      expect(count(block, 'flex-grow:')).toBe(1);
      expect(count(block, 'style="width:')).toBe(1);
      expect(markup).toContain('1 not loaded yet, not counted');
      // The weighted 7-day headline leaves the unloaded credential out as well.
      expect(markup).toContain(
        'aria-label="70% of 100% remaining across 1 credentials, in Pro weekly units"'
      );
    });

    test('lines each weight up with its own credential past one without the window', () => {
      const markup = render(
        claude('plan_max5', 40),
        claude('plan_max20', null),
        claude('plan_max20', 90)
      );
      const block = sessionBlock(markup);
      expect(markup).toContain('of 2500%');
      expect(block).toContain('across 2 credentials, in Pro 5-hour units');
      expect(block).toMatch(/flex-grow:5"><span[^>]*width:40%.*flex-grow:20"><span[^>]*width:90%/);
      expect(markup).not.toContain('not loaded yet');
    });

    test('weights the headline when the 5-hour limit is all a provider reports', () => {
      const markup = render(claude('plan_pro', 50, false), claude('plan_max20', 10, false));
      expect(count(markup, '5-hour limit')).toBe(1);
      expect(markup).toContain('250%');
      expect(markup).toContain('of 2100%');
      expect(markup).toContain('across 2 credentials, in Pro 5-hour units');
      expect(markup).toContain('style="flex-grow:20"');
      expect(count(markup, 'In Pro units')).toBe(1);
    });

    test('counts a subscription out of its 7-day limit as empty, and says so', () => {
      // The Max 20x has used up its week; its untouched session cannot be spent.
      const markup = render(claude('plan_pro', 40), claude('plan_max20', 100, true, 100));
      const block = sessionBlock(markup);
      expect(block).toContain('<span>40%</span>');
      expect(block).toContain('of 2100%');
      expect(block).toMatch(/flex-grow:20"><span[^>]*width:0%/);
      expect(markup).toContain('1 has used up its 7-day limit, counted as empty until it resets');
      // The Pro session's refill is still the pool's next top-up.
      expect(block).toContain('in 2 hours');

      const both = render(
        claude('plan_max20', 100, true, 100),
        claude('plan_max5', 100, true, 100),
        claude('plan_pro', 40)
      );
      expect(both).toContain(
        '2 have used up their 7-day limits, counted as empty until they reset'
      );
      expect(render(claude('plan_pro', 40))).not.toContain('used up');
    });

    test('holds its place while nothing that reports it has loaded', () => {
      const markup = render(null, null);
      expect(markup).toContain('Not loaded yet');
      expect(markup).toContain('5-hour limit');
      expect(markup).toContain('In Pro units');
      expect(markup).toContain('2 not loaded yet, not counted');
      // Unknown figure, no capacity to claim, and an empty track rather than a pool bar.
      expect(count(markup, '<span>--</span>')).toBe(2);
      expect(count(markup, 'in Pro 5-hour units')).toBe(0);
      expect(markup.indexOf('5-hour limit')).toBeGreaterThan(markup.indexOf('Not loaded yet'));

      // A loaded credential without the window, beside one still loading: still a
      // placeholder, below the weighted 7-day headline.
      const beside = render(claude('plan_pro', null), null);
      expect(beside).toContain('1 not loaded yet, not counted');
      expect(beside.indexOf('5-hour limit')).toBeGreaterThan(beside.indexOf('7-day limit'));
      expect(sessionBlock(beside)).toContain('<span>--</span>');
      // Everything loaded and no 5-hour limit anywhere: nothing to hold a place for.
      expect(render(claude('plan_pro', null))).not.toContain('5-hour limit');

      // Other providers' empty states are unchanged.
      for (const provider of ['codex', 'kimi'] as const) {
        const other = renderToStaticMarkup(
          createElement(QuotaSummaryStrip, {
            groups: [{ provider, summary: summarizeProvider([null, null], NOW) }],
            resolvedTheme: 'dark',
            now: NOW,
          })
        );
        expect(other).not.toContain('5-hour limit');
        expect(other).not.toContain('In Pro units');
        expect(other).not.toContain('not counted');
      }
    });
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

  test('only weighted summary bars drop the segment minimum width', () => {
    const strip = readFileSync('src/features/quota/components/QuotaSummaryStrip.tsx', 'utf8');
    const stripStyles = readFileSync(
      'src/features/quota/components/QuotaSummaryStrip.module.scss',
      'utf8'
    );
    expect(strip).toContain(
      'className={weights ? `${styles.segments} ${styles.segmentsWeighted}` : styles.segments}'
    );
    expect(stripStyles).toMatch(/\.segmentsWeighted \.segment \{\s*min-width: 0;\s*\}/);
    // Unweighted bars keep their minimum, so an empty or unloaded segment stays visible.
    expect(stripStyles).toMatch(/\n\.segment \{[^}]*min-width: 6px;/);
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

  for (const [locale, messages] of Object.entries({
    en,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    ru,
    vi,
    ko,
  })) {
    test(`${locale} translates every lane and model-block string`, () => {
      const quota = messages.quota_management as Record<string, string>;
      expect(KEYS.filter((key) => !quota[key])).toEqual([]);
      expect(messages.claude_quota.seven_day_model).toContain('{{model}}');
      expect('seven_day_fable' in messages.claude_quota).toBe(false);
    });
  }
});

const LOCALES = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ru, vi, ko };

describe('Claude 5-hour pool locale keys', () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    test(`${locale} translates the Pro-unit hint, label and stand-in note`, () => {
      const quota = messages.quota_management as Record<string, string>;
      expect(quota.summary_pro_units_hint).toContain('{{scale}}');
      for (const token of ['{{total}}', '{{capacity}}', '{{count}}']) {
        expect(quota.summary_pro_units_segments_label).toContain(token);
        expect(quota.summary_pro_units_weekly_segments_label).toContain(token);
      }
      expect(quota.summary_pro_units_weekly_segments_label).not.toBe(
        quota.summary_pro_units_segments_label
      );
      // Chinese has no plural forms; the others carry at least `_other`.
      const assumed = quota.summary_pro_units_assumed ?? quota.summary_pro_units_assumed_other;
      expect(assumed).toContain('{{count}}');
      expect(assumed).toContain('Pro');
      const notLoaded =
        quota.summary_pro_units_not_loaded ?? quota.summary_pro_units_not_loaded_other;
      expect(notLoaded).toContain('{{count}}');
      const gated = quota.summary_pro_units_gated ?? quota.summary_pro_units_gated_other;
      expect(gated).toContain('{{count}}');
      expect(gated).toContain('7');
      // Plan names stay untranslated, so the scale reads the same everywhere.
      for (const plan of ['plan_pro', 'plan_team', 'plan_max5', 'plan_max20'] as const) {
        expect(messages.claude_quota[plan]).toBe(en.claude_quota[plan]);
      }
    });
  }
});
