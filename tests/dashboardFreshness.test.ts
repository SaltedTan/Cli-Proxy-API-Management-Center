/**
 * Dashboard data freshness: a failed refresh keeps the last snapshot but flags it stale
 * with its load time, callers learn whether a refresh succeeded, and both panels say
 * when they show old data. Reads are controlled by hand; the clock is injected.
 */

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';
import { ClientUsagePanel } from '@/features/dashboard/components/ClientUsagePanel';
import { RoutingPanel } from '@/features/dashboard/components/RoutingPanel';
import type { ClientUsageState } from '@/features/dashboard/hooks/useClientUsage';
import type { RoutingObservabilityState } from '@/features/dashboard/hooks/useRoutingObservability';
import { createPolledSnapshot, unrefreshedChangeNotice } from '@/features/dashboard/polledSnapshot';
import { startVisiblePolling } from '@/features/dashboard/visiblePolling';
import { normalizeClientUsage } from '@/services/api/clientUsage';
import { normalizeRoutingObservability } from '@/services/api/routing';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const NOW = Date.parse('2026-10-09T12:00:00Z');
const MINUTE = 60_000;

/** A read the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A snapshot whose reads are queued for the test to settle, on a hand-set clock. */
function harness(options: { isUnsupported?: (error: unknown) => boolean } = {}) {
  const reads: ReturnType<typeof deferred<string>>[] = [];
  let clock = NOW;
  let revision = 1;
  const resource = createPolledSnapshot<string>({
    read: () => {
      const read = deferred<string>();
      reads.push(read);
      return read.promise;
    },
    isUnsupported: options.isUnsupported,
    connectionRevision: () => revision,
    now: () => clock,
  });
  let notifications = 0;
  resource.subscribe(() => {
    notifications += 1;
  });
  return {
    resource,
    reads,
    notifications: () => notifications,
    setClock: (ms: number) => {
      clock = ms;
    },
    reconnect: () => {
      revision += 1;
    },
  };
}

describe('polled snapshot state', () => {
  test('a first load goes from loading to ready, with its load time', async () => {
    const { resource, reads } = harness();
    expect(resource.getSnapshot()).toEqual({ status: 'idle', data: null });

    const done = resource.refresh();
    expect(resource.getSnapshot()).toEqual({ status: 'loading', data: null });
    reads[0].resolve('first');
    expect(await done).toBe(true);
    expect(resource.getSnapshot()).toEqual({ status: 'ready', data: 'first', updatedAtMs: NOW });
  });

  test('a failed refresh keeps the last data, flags it stale and resolves false', async () => {
    const { resource, reads, setClock } = harness();
    const first = resource.refresh();
    reads[0].resolve('first');
    await first;

    setClock(NOW + 3 * MINUTE);
    const failed = resource.refresh();
    // Old data stays on screen while the refresh runs.
    expect(resource.getSnapshot()).toEqual({ status: 'ready', data: 'first', updatedAtMs: NOW });
    reads[1].reject(new Error('backend down'));
    expect(await failed).toBe(false);
    expect(resource.getSnapshot()).toEqual({
      status: 'ready',
      data: 'first',
      updatedAtMs: NOW,
      stale: true,
    });

    // The next success clears the flag and records its own time.
    const recovered = resource.refresh();
    reads[2].resolve('second');
    expect(await recovered).toBe(true);
    expect(resource.getSnapshot()).toEqual({
      status: 'ready',
      data: 'second',
      updatedAtMs: NOW + 3 * MINUTE,
    });
  });

  test('repeated failures do not re-render a panel that is already stale', async () => {
    const { resource, reads, notifications } = harness();
    const first = resource.refresh();
    reads[0].resolve('first');
    await first;
    const failed = resource.refresh();
    reads[1].reject(new Error('down'));
    await failed;
    const before = notifications();
    const again = resource.refresh();
    reads[2].reject(new Error('still down'));
    expect(await again).toBe(false);
    expect(notifications()).toBe(before);
  });

  test('a failure without data is an error; an unsupported backend is not', async () => {
    const failing = harness();
    const failed = failing.resource.refresh();
    failing.reads[0].reject(new Error('down'));
    expect(await failed).toBe(false);
    expect(failing.resource.getSnapshot()).toEqual({ status: 'error', data: null });

    const unsupported = harness({ isUnsupported: (error) => error === 'not found' });
    const answered = unsupported.resource.refresh();
    unsupported.reads[0].reject('not found');
    expect(await answered).toBe(true);
    expect(unsupported.resource.getSnapshot()).toEqual({ status: 'unsupported', data: null });
  });

  test('results for another connection or scope are discarded', async () => {
    const reconnected = harness();
    const stale = reconnected.resource.refresh();
    reconnected.reconnect();
    reconnected.reads[0].resolve('old connection');
    expect(await stale).toBe(false);
    expect(reconnected.resource.getSnapshot().data).toBeNull();

    const rescoped = harness();
    const old = rescoped.resource.refresh();
    rescoped.resource.reset();
    rescoped.reads[0].reject(new Error('old scope failed'));
    expect(await old).toBe(false);
    expect(rescoped.resource.getSnapshot()).toEqual({ status: 'idle', data: null });
  });
});

describe('dashboard credential data', () => {
  test('a newer refresh waits for the older read, so responses arrive in order', async () => {
    const { resource, reads } = harness();
    const older = resource.refresh();
    const newer = resource.refresh();
    // The second read starts only once the first has settled.
    expect(reads).toHaveLength(1);
    reads[0].resolve('older');
    expect(await older).toBe(true);
    await Promise.resolve();
    expect(reads).toHaveLength(2);
    reads[1].resolve('newer');
    expect(await newer).toBe(true);
    expect(resource.getSnapshot().data).toBe('newer');
  });

  test('auth files are polled like routing, through the guarded snapshot', async () => {
    const { AUTH_FILES_POLL_INTERVAL_MS } =
      await import('@/features/dashboard/hooks/useDashboardOverview');
    const { ROUTING_POLL_INTERVAL_MS } =
      await import('@/features/dashboard/hooks/useRoutingObservability');
    expect(AUTH_FILES_POLL_INTERVAL_MS).toBe(ROUTING_POLL_INTERVAL_MS);
    const source = await Bun.file(
      new URL('../src/features/dashboard/hooks/useDashboardOverview.ts', import.meta.url)
    ).text();
    const polled = source.slice(source.indexOf('usePolledSnapshot({'));
    const options = polled.slice(0, polled.indexOf('});'));
    expect(options).toContain('scope: apiBase');
    expect(options).toContain('intervalMs: AUTH_FILES_POLL_INTERVAL_MS');
    expect(options).toContain('read: readAuthFiles');
    // No unguarded state write is left behind.
    expect(source).not.toContain('setAuthFiles');
    expect(source.match(/authFilesApi\.list\(/g)).toHaveLength(1);
  });
});

describe('overlapping reads', () => {
  /** Lets queued promise callbacks run; no timers involved. */
  const flush = async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };

  test('a poll joins the read in flight instead of starting another', async () => {
    const { resource, reads } = harness();
    const manual = resource.refresh();
    const polled = resource.poll();
    expect(reads).toHaveLength(1);
    reads[0].resolve('only');
    expect(await polled).toBe(true);
    expect(await manual).toBe(true);
    expect(reads).toHaveLength(1);
  });

  test('refreshes during a read share one follow-up read, and polls join it', async () => {
    const { resource, reads } = harness();
    const first = resource.poll();
    const a = resource.refresh();
    const b = resource.refresh();
    const polled = resource.poll();
    expect(a).toBe(b);
    expect(polled).toBe(a);
    reads[0].resolve('before the change');
    await first;
    await flush();
    expect(reads).toHaveLength(2);
    reads[1].resolve('after the change');
    expect(await a).toBe(true);
    expect(resource.getSnapshot().data).toBe('after the change');
    expect(reads).toHaveLength(2);
  });

  test('a refresh after the read settled starts a new one at once', async () => {
    const { resource, reads } = harness();
    const first = resource.refresh();
    reads[0].resolve('first');
    await first;
    void resource.refresh();
    expect(reads).toHaveLength(2);
  });

  test('a scope reset drops the queued follow-up read', async () => {
    const { resource, reads } = harness();
    void resource.refresh();
    const queued = resource.refresh();
    resource.reset();
    reads[0].resolve('old scope');
    expect(await queued).toBe(false);
    await flush();
    expect(reads).toHaveLength(1);
    expect(resource.getSnapshot()).toEqual({ status: 'idle', data: null });
    // The new scope reads at once, without waiting for the old one.
    void resource.refresh();
    expect(reads).toHaveLength(2);
  });
});

describe('polling while the tab is hidden', () => {
  function pollingHarness() {
    let tick: (() => void) | null = null;
    let visibilityListener: (() => void) | null = null;
    let hidden = false;
    let polls = 0;
    let cleared = 0;
    const stop = startVisiblePolling({
      intervalMs: 30_000,
      poll: () => {
        polls += 1;
      },
      isHidden: () => hidden,
      onVisibilityChange: (listener) => {
        visibilityListener = listener;
        return () => {
          visibilityListener = null;
        };
      },
      setTimer: (fn, ms) => {
        expect(ms).toBe(30_000);
        tick = fn;
        return 7;
      },
      clearTimer: (id) => {
        expect(id).toBe(7);
        cleared += 1;
      },
    });
    return {
      stop,
      tick: () => tick?.(),
      setHidden: (value: boolean) => {
        hidden = value;
        visibilityListener?.();
      },
      polls: () => polls,
      cleared: () => cleared,
      listening: () => visibilityListener !== null,
    };
  }

  test('polls on each tick while visible', () => {
    const polling = pollingHarness();
    polling.tick();
    polling.tick();
    expect(polling.polls()).toBe(2);
  });

  test('skips ticks while hidden and polls once when visible again', () => {
    const polling = pollingHarness();
    polling.setHidden(true);
    polling.tick();
    polling.tick();
    expect(polling.polls()).toBe(0);
    polling.setHidden(false);
    expect(polling.polls()).toBe(1);
    // Only the skipped ticks are made up for, once.
    polling.setHidden(true);
    polling.setHidden(false);
    expect(polling.polls()).toBe(1);
  });

  test('a brief hide between ticks does not poll early', () => {
    const polling = pollingHarness();
    polling.setHidden(true);
    polling.setHidden(false);
    expect(polling.polls()).toBe(0);
  });

  test('stopping clears the timer and the visibility listener', () => {
    const polling = pollingHarness();
    polling.stop();
    expect(polling.cleared()).toBe(1);
    expect(polling.listening()).toBe(false);
  });
});

describe('a change followed by a refresh', () => {
  test('save and reset resolve whether the usage panel could be reloaded', async () => {
    const source = await Bun.file(
      new URL('../src/features/dashboard/hooks/useDashboardOverview.ts', import.meta.url)
    ).text();
    const save = source.slice(source.indexOf('const saveClientLimit = useCallback'));
    const saveBody = save.slice(0, save.indexOf('}, ['));
    expect(saveBody).toContain(
      'const [usage] = await Promise.allSettled([refreshClientUsage(), fetchConfig(true)]);'
    );
    // The config reload cannot decide the outcome; the usage reload does.
    expect(saveBody).toContain("return usage.status === 'fulfilled' && usage.value;");
    const reset = source.slice(source.indexOf('const resetClientWindow = useCallback'));
    expect(reset.slice(0, reset.indexOf('}, ['))).toContain('return refreshClientUsage();');
  });

  test('warns only when the saved change could not be shown', () => {
    expect(unrefreshedChangeNotice(true, 'dashboard.client_usage_limit_saved_stale')).toBeNull();
    // Callers that do not report the reload are treated as reloaded.
    expect(unrefreshedChangeNotice(undefined, 'dashboard.client_usage_limit_saved_stale')).toBe(
      null
    );
    expect(unrefreshedChangeNotice(false, 'dashboard.client_usage_window_reset_stale')).toEqual({
      key: 'dashboard.client_usage_window_reset_stale',
      type: 'warning',
    });
  });
});

const usageSnapshot = normalizeClientUsage({
  generated_at: '2026-10-09T11:57:00Z',
  since: '2026-10-01T00:00:00Z',
  claude_limits_supported: true,
  keys: [],
  claude_credentials: [],
});

const renderUsage = (usage: ClientUsageState, onRefresh?: () => Promise<unknown>) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        null,
        createElement(ClientUsagePanel, { usage, localNames: new Map(), onRefresh, nowMs: NOW })
      )
    )
  );

const routingSnapshot = normalizeRoutingObservability({
  observed_at: '2026-10-09T11:57:00Z',
  mode: 'local',
  strategy: 'round-robin',
  session_affinity: { enabled: false },
  counters: {},
  recent: [],
});

const renderRouting = (routing: RoutingObservabilityState, onRefresh?: () => Promise<unknown>) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        null,
        createElement(RoutingPanel, {
          routing,
          config: null,
          authFiles: [],
          onRefresh,
          nowMs: NOW,
        })
      )
    )
  );

/** React escapes apostrophes in rendered text. */
const html = (text: string) => text.replace(/'/g, '&#x27;');

const staleText = (minutesAgo: number) =>
  html(
    t('dashboard.refresh_stale', {
      time: new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(-minutesAgo, 'minute'),
    })
  );

describe('stale data notices', () => {
  const refresh = async () => true;

  test('the usage panel says how old the data shown is, with a retry', () => {
    const fresh = renderUsage({ status: 'ready', data: usageSnapshot, updatedAtMs: NOW }, refresh);
    expect(fresh).not.toContain(t('dashboard.refresh_retry'));

    const stale = renderUsage(
      { status: 'ready', data: usageSnapshot, updatedAtMs: NOW - 3 * MINUTE, stale: true },
      refresh
    );
    expect(stale).toContain(staleText(3));
    expect(stale).toContain('role="status"');
    expect(stale).toContain(
      `aria-label="${t('dashboard.client_usage_refresh_label')}">` +
        `<span>${t('dashboard.refresh_retry')}</span>`
    );

    // Without a way to refresh there is nothing to retry, but the notice stays.
    const readOnly = renderUsage({
      status: 'ready',
      data: usageSnapshot,
      updatedAtMs: NOW - 3 * MINUTE,
      stale: true,
    });
    expect(readOnly).toContain(staleText(3));
    expect(readOnly).not.toContain(t('dashboard.refresh_retry'));
  });

  test('the routing panel says how old the data shown is, with a retry', () => {
    const fresh = renderRouting(
      { status: 'ready', data: routingSnapshot, updatedAtMs: NOW },
      refresh
    );
    expect(fresh).not.toContain(t('dashboard.refresh_retry'));

    const stale = renderRouting(
      { status: 'ready', data: routingSnapshot, updatedAtMs: NOW - 10 * MINUTE, stale: true },
      refresh
    );
    expect(stale).toContain(staleText(10));
    expect(stale).toContain(`aria-label="${t('dashboard.routing_refresh_label')}"`);
  });

  test('a load time ahead of the coarse panel clock never reads as future', () => {
    const markup = renderUsage(
      { status: 'ready', data: usageSnapshot, updatedAtMs: NOW + 20_000, stale: true },
      refresh
    );
    expect(markup).toContain(staleText(1));
  });

  test('an unknown load time falls back to a plain notice', () => {
    const markup = renderUsage({ status: 'ready', data: usageSnapshot, stale: true }, refresh);
    expect(markup).toContain(html(t('dashboard.refresh_failed')));
  });

  test('every notice label exists in all four languages with the same placeholders', () => {
    const placeholders = (value: string) => (value.match(/{{\s*\w+\s*}}/g) ?? []).sort();
    const english = en.dashboard as Record<string, string>;
    const keys = [
      'refresh_stale',
      'refresh_failed',
      'refresh_retry',
      'client_usage_limit_saved_stale',
      'client_usage_window_reset_stale',
    ];
    for (const locale of [zhCN, zhTW, ru]) {
      const dashboard = locale.dashboard as Record<string, string>;
      for (const name of keys) {
        expect(english[name]?.trim()).toBeTruthy();
        expect(dashboard[name]?.trim()).toBeTruthy();
        expect(dashboard[name]).not.toBe(english[name]);
        expect(placeholders(dashboard[name])).toEqual(placeholders(english[name]));
      }
    }
  });
});
