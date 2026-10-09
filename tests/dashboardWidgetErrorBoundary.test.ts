/**
 * A render error in one dashboard widget must stay inside that widget. There is no DOM
 * harness, so the boundary's React contract (derived state, fallback, retry) is driven
 * directly and its fallback rendered as static markup.
 */

import { describe, expect, test } from 'bun:test';
import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';
import {
  WidgetErrorBoundary,
  WidgetErrorCard,
} from '@/features/dashboard/components/WidgetErrorBoundary';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n);

const NAME = 'Usage by API key';
const child = createElement('p', null, 'widget body');

const boundary = () => new WidgetErrorBoundary({ name: NAME, children: child });

describe('dashboard widget error boundary', () => {
  test('renders the widget until it fails', () => {
    expect(boundary().render()).toBe(child);
  });

  test('a render error switches it to the error card', () => {
    expect(WidgetErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const instance = boundary();
    instance.state = WidgetErrorBoundary.getDerivedStateFromError();
    const fallback = instance.render();
    expect(isValidElement(fallback)).toBe(true);
    const card = fallback as ReactElement<{ name: string; onRetry: () => void }>;
    expect(card.type).toBe(WidgetErrorCard);
    expect(card.props.name).toBe(NAME);
    expect(card.props.onRetry).toBe(instance.retry);
  });

  test('retry renders the widget again', () => {
    const instance = boundary();
    instance.state = { failed: true };
    const updates: unknown[] = [];
    instance.setState = (update) => {
      updates.push(update);
    };
    instance.retry();
    expect(updates).toEqual([{ failed: false }]);
  });

  test('the error card is an alert naming the widget, with a labelled retry', () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(WidgetErrorCard, { name: NAME, onRetry: () => undefined })
      )
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(t('dashboard.widget_error', { name: NAME }));
    expect(markup).toContain(
      `aria-label="${t('dashboard.widget_error_retry_label', { name: NAME })}"`
    );
    expect(markup).toContain(`<span>${t('dashboard.refresh_retry')}</span>`);
    expect(markup).toContain('type="button"');
  });

  test('the dashboard wraps each fork-owned widget in its own boundary', async () => {
    const page = await Bun.file(
      new URL('../src/features/dashboard/DashboardPage.tsx', import.meta.url)
    ).text();
    for (const [title, widget] of [
      ['client_usage_title', 'ClientUsagePanel'],
      ['routing_title', 'RoutingPanel'],
    ]) {
      const open = page.indexOf(`<WidgetErrorBoundary name={t('dashboard.${title}')}>`);
      expect(open).toBeGreaterThan(-1);
      const inner = page.slice(open, page.indexOf('</WidgetErrorBoundary>', open));
      expect(inner).toContain(`<${widget}`);
    }
  });

  test('its labels exist in all four languages with the same placeholders', () => {
    const placeholders = (value: string) => (value.match(/{{\s*\w+\s*}}/g) ?? []).sort();
    const english = en.dashboard as Record<string, string>;
    for (const locale of [zhCN, zhTW, ru]) {
      const dashboard = locale.dashboard as Record<string, string>;
      for (const name of ['widget_error', 'widget_error_retry_label']) {
        expect(dashboard[name]?.trim()).toBeTruthy();
        expect(dashboard[name]).not.toBe(english[name]);
        expect(placeholders(dashboard[name])).toEqual(placeholders(english[name]));
      }
    }
  });
});
