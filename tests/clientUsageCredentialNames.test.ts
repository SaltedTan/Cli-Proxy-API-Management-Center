import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { normalizeClientUsage } from '@/services/api/clientUsage';
import { ClientUsagePanel } from '@/features/dashboard/components/ClientUsagePanel';
import { claudeCredentialName } from '@/features/dashboard/clientUsage';
import { buildCredentialLabels } from '@/features/dashboard/routing';
import type { AuthFileItem } from '@/types/authFile';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

const NOW = Date.parse('2026-10-07T12:00:00Z');
const EMAIL = 'sam@example.com';

// One account email in two Claude organizations: the backend labels both with the email.
const authFiles = [
  { name: 'claude-alpha.json', email: EMAIL, authIndex: 'idx_alpha', organizationName: 'Alpha' },
  { name: 'claude-beta.json', email: EMAIL, authIndex: 'idx_beta', organizationName: 'Beta' },
] as AuthFileItem[];

const credential = (authId: string, authIndex: string, fraction: number) => ({
  auth_id: authId,
  auth_index: authIndex,
  label: EMAIL,
  plan: 'max_5x',
  plan_pro_units: 5,
  plan_source: 'rate_limit_tier',
  current_fraction: fraction,
  current_pro_units: fraction * 5,
  total_fraction: fraction,
  total_pro_units: fraction * 5,
});

const snapshot = normalizeClientUsage({
  generated_at: '2026-10-07T12:00:00Z',
  keys: [
    {
      id: 'c0ffee00c0ffee00',
      name: 'MacBook',
      configured: true,
      last_used_at: '2026-10-07T11:00:00Z',
      totals: { requests: 3, tokens: { total_tokens: 30 } },
      claude: {
        current_pro_units: 1,
        total_pro_units: 1,
        credentials: [
          credential('claude-alpha.json', 'idx_alpha', 0.1),
          credential('claude-beta.json', 'idx_beta', 0.1),
        ],
      },
    },
  ],
  claude_credentials: [
    {
      auth_id: 'claude-alpha.json',
      auth_index: 'idx_alpha',
      label: EMAIL,
      plan: 'max_5x',
      plan_pro_units: 5,
      weekly_utilization: 0.2,
      window_resets_at: '2026-10-09T00:00:00Z',
    },
    {
      auth_id: 'claude-beta.json',
      auth_index: 'idx_beta',
      label: EMAIL,
      plan: 'max_5x',
      plan_pro_units: 5,
      weekly_utilization: 0.3,
      window_resets_at: '2026-10-09T00:00:00Z',
    },
  ],
});

const render = (files: AuthFileItem[] | null) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemoryRouter,
        null,
        createElement(ClientUsagePanel, {
          usage: { status: 'ready', data: snapshot },
          localNames: new Map(),
          config: null,
          authFiles: files,
          nowMs: NOW,
        })
      )
    )
  );

describe('client usage credential names', () => {
  test('use the routing label for the auth index, then the backend label, then the id', () => {
    const labels = buildCredentialLabels(authFiles, null);
    const alpha = { authId: 'claude-alpha.json', authIndex: 'idx_alpha', label: EMAIL };
    expect(claudeCredentialName(alpha, labels)).toBe(`${EMAIL} · Alpha`);
    expect(claudeCredentialName({ ...alpha, authIndex: ' idx_beta ' }, labels)).toBe(
      `${EMAIL} · Beta`
    );
    // A credential the auth-file listing does not know (removed, or not loaded yet).
    expect(claudeCredentialName({ ...alpha, authIndex: 'idx_gone' }, labels)).toBe(EMAIL);
    expect(claudeCredentialName({ ...alpha, authIndex: undefined }, labels)).toBe(EMAIL);
    expect(claudeCredentialName({ ...alpha, label: undefined }, new Map())).toBe(
      'claude-alpha.json'
    );
  });

  test('tell apart same-email credentials in the strip and in the per-key breakdown', () => {
    const markup = render(authFiles);
    for (const organization of ['Alpha', 'Beta']) {
      const name = `${EMAIL} · ${organization}`;
      // Credential strip: the card's name and its meter's accessible name.
      expect(markup).toContain(`>${name}</span>`);
      expect(markup).toContain(
        i18n.t('dashboard.client_usage_utilization_label', { name }).replace(/'/g, '&#x27;')
      );
      // Per-key breakdown.
      expect(markup).toMatch(new RegExp(`<li>${name} · `));
    }
    // Without the auth-file listing the backend's labels are kept.
    const bare = render(null);
    expect(bare).not.toContain(`${EMAIL} · Alpha`);
    expect(bare).toContain(`>${EMAIL}</span>`);
  });
});
