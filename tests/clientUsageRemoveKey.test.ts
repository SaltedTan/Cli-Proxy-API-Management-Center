import { describe, expect, test } from 'bun:test';
import { createElement, type KeyboardEvent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { RemoveKeyConfirm } from '@/features/dashboard/components/ClientUsagePanel';

const i18n = createInstance();
await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } });
const t = i18n.t.bind(i18n);

const NAME = 'c0ffee00c0ffee00';
const keepRef = { current: null };
const props = (overrides: Partial<Parameters<typeof RemoveKeyConfirm>[0]> = {}) => ({
  name: NAME,
  t,
  withLimit: false,
  removing: false,
  keepRef,
  onConfirm: () => undefined,
  onCancel: () => undefined,
  onKeyDown: (_event: KeyboardEvent<HTMLElement>) => undefined,
  ...overrides,
});

const render = (overrides: Partial<Parameters<typeof RemoveKeyConfirm>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(RemoveKeyConfirm, props(overrides)))
  );

/** Buttons of the confirmation, in order, from the element tree (the component has no hooks). */
const buttons = (overrides: Partial<Parameters<typeof RemoveKeyConfirm>[0]> = {}) => {
  const group = RemoveKeyConfirm(props(overrides)) as ReactElement<{
    onKeyDown: unknown;
    children: ReactElement<Record<string, unknown>>[];
  }>;
  return { group, buttons: group.props.children.slice(1) };
};

describe('client usage key removal confirmation', () => {
  test('is a labelled group whose safe choice, Keep, carries the focus target', () => {
    const question = t('dashboard.client_usage_remove_confirm', { name: NAME });
    const markup = render();
    expect(markup).toContain(`role="group" aria-label="${question}"`);
    expect(markup).toContain(`<span>${question}</span>`);
    expect(markup).toContain('btn btn-danger btn-sm');
    expect(markup).toContain(
      `aria-label="${t('dashboard.client_usage_remove_yes_label', { name: NAME })}"`
    );
    expect(markup).toContain(t('dashboard.client_usage_remove_no'));
    expect(markup).not.toContain('disabled=""');
    const {
      group,
      buttons: [remove, keep],
    } = buttons();
    // Escape is handled on the whole group, so it works from either button.
    expect(typeof group.props.onKeyDown).toBe('function');
    // Opening the confirmation replaces the trigger, so focus must land inside it: on
    // Keep, which cannot delete anything.
    expect(keep.props.ref).toBe(keepRef);
    expect(remove.props.ref).toBeUndefined();
  });

  test('says when the Claude allowance is deleted too', () => {
    const markup = render({ withLimit: true });
    const question = t('dashboard.client_usage_remove_confirm_limit', { name: NAME });
    expect(markup).toContain(`role="group" aria-label="${question}"`);
    expect(markup).toContain(`<span>${question}</span>`);
    expect(markup).not.toContain(t('dashboard.client_usage_remove_confirm', { name: NAME }));
  });

  test('disables both choices while the removal is in flight', () => {
    const markup = render({ removing: true });
    expect(markup).toContain('loading-spinner');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
