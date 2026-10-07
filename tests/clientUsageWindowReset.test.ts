import { describe, expect, test } from 'bun:test';
import { createElement, type KeyboardEvent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { WindowResetConfirm } from '@/features/dashboard/components/ClientUsagePanel';
import { claudeWindowIdentity } from '@/features/dashboard/clientUsage';

const i18n = createInstance();
await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } });
const t = i18n.t.bind(i18n);

const keepRef = { current: null };
const props = (overrides: Partial<Parameters<typeof WindowResetConfirm>[0]> = {}) => ({
  name: 'MacBook',
  t,
  resetting: false,
  keepRef,
  onConfirm: () => undefined,
  onCancel: () => undefined,
  onKeyDown: (_event: KeyboardEvent<HTMLElement>) => undefined,
  ...overrides,
});

const render = (overrides: Partial<Parameters<typeof WindowResetConfirm>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(WindowResetConfirm, props(overrides)))
  );

/** Buttons of the confirmation, in order, from the element tree (the component has no hooks). */
const buttons = (overrides: Partial<Parameters<typeof WindowResetConfirm>[0]> = {}) => {
  const group = WindowResetConfirm(props(overrides)) as ReactElement<{
    onKeyDown: unknown;
    children: ReactElement<Record<string, unknown>>[];
  }>;
  return { group, buttons: group.props.children.slice(1) };
};

describe('client usage window reset confirmation', () => {
  test('is a labelled group whose safe choice, Keep, carries the focus target', () => {
    const markup = render();
    expect(markup).toContain(
      `role="group" aria-label="${t('dashboard.client_usage_window_reset_confirm', { name: 'MacBook' })}"`
    );
    expect(markup).toContain('btn btn-danger btn-sm');
    expect(markup).toContain(
      `aria-label="${t('dashboard.client_usage_window_reset_yes_label', { name: 'MacBook' })}"`
    );
    expect(markup).toContain(t('dashboard.client_usage_window_reset_no'));
    expect(markup).not.toContain('disabled=""');
    const { group, buttons: [reset, keep] } = buttons();
    // Escape is handled on the whole group, so it works from either button.
    expect(typeof group.props.onKeyDown).toBe('function');
    // Opening the confirmation replaces the trigger, so focus must land inside it: on
    // Keep, which cannot destroy anything.
    expect(keep.props.ref).toBe(keepRef);
    expect(reset.props.ref).toBeUndefined();
  });

  test('disables both choices while the reset is in flight', () => {
    const markup = render({ resetting: true });
    expect(markup).toContain('loading-spinner');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  test('a confirmation is bound to the window it was asked about', () => {
    // A confirmation stays only while the same window is open; a poll that ends the
    // window, or a later request that opens another one, changes the identity.
    expect(claudeWindowIdentity(null)).toBe(null);
    expect(claudeWindowIdentity({ startedAtMs: 1, resetsAtMs: 2 })).toBe(2);
    expect(claudeWindowIdentity({ startedAtMs: null, resetsAtMs: 2 })).toBe(2);
    expect(claudeWindowIdentity({ startedAtMs: 1, resetsAtMs: 3 })).not.toBe(
      claudeWindowIdentity({ startedAtMs: 1, resetsAtMs: 2 })
    );
  });
});
