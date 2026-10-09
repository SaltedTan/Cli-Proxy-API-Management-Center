import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { SectionNetwork } from '@/features/config/components/sections/SectionNetwork';
import { sessionAffinityTTLError } from '@/features/config/routingConfig';
import { countSectionErrors } from '@/features/config/uiState';
import { DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';
import { runVisualConfig } from './helpers/visualConfig';

const dirty = new Set(['routingSessionAffinityTTL']);

describe('session affinity TTL validation', () => {
  test('accepts positive Go durations and blank', () => {
    for (const value of ['30m', '1h30m', '90s', '1.5h', '300ms', ' 2h ', '+45m', '1ns', '']) {
      expect(sessionAffinityTTLError(value, dirty)).toBeUndefined();
    }
  });

  test('rejects values the backend would replace with the 1h default', () => {
    for (const value of ['1 hour', '1d', '30', 'abc', '1h 30m', '.h', '1H']) {
      expect(sessionAffinityTTLError(value, dirty)).toBe('invalid_duration');
    }
    for (const value of ['0', '0s', '-1h', '0.0000000001s']) {
      expect(sessionAffinityTTLError(value, dirty)).toBe('positive_duration');
    }
  });

  test('blocks saving a newly edited invalid TTL', () => {
    const yaml = 'config-version: 8\nrouting:\n  session-affinity-ttl: 1h\n';
    const config = runVisualConfig(yaml, [{ routingSessionAffinityTTL: '1day' }]);
    expect(config.visualValidationErrors.routingSessionAffinityTTL).toBe('invalid_duration');
    expect(countSectionErrors(config.visualValidationErrors, false).network).toBe(1);
  });

  test('an untouched existing value does not block unrelated edits', () => {
    const yaml = 'config-version: 8\nrouting:\n  session-affinity-ttl: forever\n';
    const config = runVisualConfig(yaml, [{ port: '9000' }]);
    expect(config.visualValidationErrors.routingSessionAffinityTTL).toBeUndefined();
  });

  test('shows the error inline on the field', () => {
    const translations = i18n.cloneInstance({ lng: 'en' });
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: translations },
        createElement(SectionNetwork, {
          values: { ...DEFAULT_VISUAL_VALUES, routingSessionAffinityTTL: '0s' },
          validationErrors: { routingSessionAffinityTTL: 'positive_duration' },
          disabled: false,
          onChange: () => {},
        })
      )
    );
    expect(markup).toContain(
      translations.t('config_management.visual.validation.positive_duration')
    );
  });
});
