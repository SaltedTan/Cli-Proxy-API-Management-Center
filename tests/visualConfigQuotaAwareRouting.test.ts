import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { parse as parseYaml } from 'yaml';
import i18n from '@/i18n';
import { SectionNetwork } from '@/features/config/components/sections/SectionNetwork';
import { VISUAL_ROUTING_STRATEGIES } from '@/features/config/routingConfig';
import { parseRoutingStrategy } from '@/hooks/useVisualConfig';
import { DEFAULT_VISUAL_VALUES, type RoutingStrategy } from '@/types/visualConfig';
import { runVisualConfig } from './helpers/visualConfig';

// Mirrors routingStrategyName in the backend's sdk/cliproxy/service_config.go.
const BACKEND_NAMES: Record<string, RoutingStrategy> = {
  'round-robin': 'round-robin',
  roundrobin: 'round-robin',
  rr: 'round-robin',
  'weighted-round-robin': 'weighted-round-robin',
  weightedroundrobin: 'weighted-round-robin',
  wrr: 'weighted-round-robin',
  'fill-first': 'fill-first',
  fillfirst: 'fill-first',
  ff: 'fill-first',
  'quota-aware': 'quota-aware',
  quotaaware: 'quota-aware',
  qa: 'quota-aware',
  'reset-priority': 'quota-aware',
};

const routingYaml = (strategy: string) =>
  `config-version: 8\nrouting:\n  strategy: ${JSON.stringify(strategy)}\n`;

describe('visual config quota-aware routing strategy', () => {
  test('every backend strategy is selectable', () => {
    expect([...VISUAL_ROUTING_STRATEGIES].sort()).toEqual(
      [...new Set(Object.values(BACKEND_NAMES))].sort()
    );
  });

  for (const [name, canonical] of Object.entries(BACKEND_NAMES)) {
    test(`reads ${name} as ${canonical} and keeps it when untouched`, () => {
      expect(parseRoutingStrategy(name)).toBe(canonical);
      expect(parseRoutingStrategy(` ${name.toUpperCase()} `)).toBe(canonical);
      const yaml = routingYaml(name);
      const config = runVisualConfig(yaml, [{ port: '9000' }]);
      expect(config.visualValues.routingStrategy).toBe(canonical);
      expect(parseYaml(config.applyVisualChangesToYaml(yaml)).routing.strategy).toBe(name);
    });
  }

  test('unknown and blank names show the round-robin the backend runs', () => {
    expect(parseRoutingStrategy('quota_aware')).toBe('round-robin');
    expect(parseRoutingStrategy('')).toBe('round-robin');
    expect(parseRoutingStrategy(null)).toBe('round-robin');
  });

  for (const strategy of VISUAL_ROUTING_STRATEGIES) {
    test(`writes ${strategy} and reads it back`, () => {
      const yaml = routingYaml(strategy === 'quota-aware' ? 'round-robin' : 'quota-aware');
      const written = runVisualConfig(yaml, [
        { routingStrategy: strategy },
      ]).applyVisualChangesToYaml(yaml);
      expect(parseYaml(written).routing.strategy).toBe(strategy);
      expect(runVisualConfig(written).visualValues.routingStrategy).toBe(strategy);
    });
  }

  test('shows the selected quota-aware option with its description', () => {
    const translations = i18n.cloneInstance({ lng: 'en' });
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: translations },
        createElement(SectionNetwork, {
          values: { ...DEFAULT_VISUAL_VALUES, routingStrategy: 'quota-aware' },
          disabled: false,
          onChange: () => {},
        })
      )
    );
    expect(markup).toContain(
      translations.t('config_management.visual.sections.network.strategy_quota_aware')
    );
    expect(markup).toContain(
      translations.t('config_management.visual.sections.network.strategy_quota_aware_hint')
    );
  });
});
