import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { ClaudeLimitEditorForm } from '@/features/dashboard/components/ClientUsagePanel';
import type { KeyboardEvent } from 'react';

const i18n = createInstance();
await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } });
const t = i18n.t.bind(i18n);
/** React escapes apostrophes in rendered text. */
const html = (text: string) => text.replace(/'/g, '&#x27;');

const render = (props: Partial<Parameters<typeof ClaudeLimitEditorForm>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ClaudeLimitEditorForm, {
        name: 'MacBook',
        t,
        draft: '1.23',
        invalid: false,
        saving: false,
        hintId: 'hint',
        inputRef: { current: null },
        onDraftChange: () => undefined,
        onSubmit: () => undefined,
        onCancel: () => undefined,
        onKeyDown: () => undefined,
        ...props,
      })
    )
  );

describe('client usage allowance editor', () => {
  test('submits without native constraint validation so off-step values reach the handler', () => {
    const markup = render();
    // A configured 1.23 is not on the 0.05 spinner step and must still be submittable;
    // the handler validates instead of the browser.
    expect(markup).toMatch(/<form [^>]*novalidate=""/i);
    expect(markup).toContain('type="number"');
    expect(markup).toMatch(/inputmode="decimal"/i);
    expect(markup).toContain('step="0.05"');
    expect(markup).toContain('min="0"');
    expect(markup).toContain('value="1.23"');
    expect(markup).toContain(`aria-label="${t('dashboard.client_usage_limit_input_label', { name: 'MacBook' })}"`);
    expect(markup).toContain('aria-describedby="hint"');
    expect(markup).not.toContain('aria-invalid');
    expect(markup).toContain(html(t('dashboard.client_usage_limit_hint')));
    expect(markup).not.toContain('disabled=""');
  });

  test('marks bad input and disables the controls while saving', () => {
    const invalid = render({ invalid: true });
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain(html(t('dashboard.client_usage_limit_invalid')));
    const saving = render({ saving: true });
    // The input and both buttons.
    expect(saving.match(/disabled=""/g)).toHaveLength(3);
  });

  test('Escape is handled on the whole form, not only while the input has focus', () => {
    const onKeyDown = (_event: KeyboardEvent<HTMLElement>) => undefined;
    // The component has no hooks, so its element tree can be inspected directly.
    const form = ClaudeLimitEditorForm({
      name: 'MacBook',
      t,
      draft: '',
      invalid: false,
      saving: false,
      hintId: 'hint',
      inputRef: { current: null },
      onDraftChange: () => undefined,
      onSubmit: () => undefined,
      onCancel: () => undefined,
      onKeyDown,
    });
    expect(form.type).toBe('form');
    expect(form.props.onKeyDown).toBe(onKeyDown);
  });
});
