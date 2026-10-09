import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { normalizeAuthFilesResponse } from '@/services/api/authFiles';
import { AuthFileRefreshFailure } from '@/features/authFiles/components/AuthFileRefreshFailure';
import { isProblemAuthFile } from '@/features/authFiles/constants';
import {
  describeAuthFileRefreshFailure,
  getAuthFileRefreshFailure,
} from '@/features/authFiles/refreshFailure';
import type { AuthFileItem, AuthFilesResponse } from '@/types/authFile';
import { formatDateTimeValue } from '@/utils/format';

const normalize = (entry: Record<string, unknown>): AuthFileItem =>
  normalizeAuthFilesResponse({
    files: [{ name: 'codex.json', type: 'codex', ...entry }],
  } as unknown as AuthFilesResponse).files[0];

// A transient failure as GET /credentials reports it: no status_message.
const failing = {
  status: 'active',
  status_message: '',
  refresh_error: {
    message: 'token refresh failed with status 503: <b>upstream</b> unavailable',
    http_status: 503,
    at: '2026-10-09T10:00:00Z',
  },
  next_refresh_after: '2026-10-09T10:05:00Z',
};

describe('auth file refresh failures', () => {
  test('normalizes refresh_error and next_refresh_after in the API layer', () => {
    expect(normalize(failing).refreshError).toEqual({
      message: 'token refresh failed with status 503: <b>upstream</b> unavailable',
      httpStatus: 503,
      failedAt: '2026-10-09T10:00:00.000Z',
      nextRefreshAfter: '2026-10-09T10:05:00.000Z',
    });
    expect(
      normalize({
        refresh_error: { message: ' ', code: 'invalid_grant', http_status: 'x', at: 'never' },
      }).refreshError
    ).toEqual({ message: '', code: 'invalid_grant' });
  });

  test('ignores a missing or malformed refresh_error', () => {
    expect(normalize({ status: 'active' }).refreshError).toBeUndefined();
    expect(normalize({ refresh_error: 'boom' }).refreshError).toBeUndefined();
    expect(normalize({ refresh_error: null }).refreshError).toBeUndefined();
  });

  test('stays out of the problem set used for bulk deletes', () => {
    const file = normalize(failing);
    expect(getAuthFileRefreshFailure(file)).not.toBeNull();
    expect(isProblemAuthFile(file)).toBe(false);
  });

  test('is hidden for disabled credentials, which are not refreshed', () => {
    expect(getAuthFileRefreshFailure(normalize({ ...failing, disabled: true }))).toBeNull();
    expect(getAuthFileRefreshFailure(normalize({ ...failing, status: 'disabled' }))).toBeNull();
  });

  test('falls back to status and code when the message is empty', () => {
    expect(describeAuthFileRefreshFailure({ message: '', httpStatus: 400, code: 'x' })).toBe(
      'HTTP 400 · x'
    );
    expect(describeAuthFileRefreshFailure({ message: '' })).toBe('');
  });

  test('renders the error as text with the failure and next attempt times', () => {
    const translations = i18n.cloneInstance({ lng: 'en' });
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: translations },
        createElement(AuthFileRefreshFailure, { file: normalize(failing) })
      )
    );
    expect(markup).toContain(translations.t('auth_files.refresh_failing'));
    expect(markup).toContain('&lt;b&gt;upstream&lt;/b&gt; unavailable');
    expect(markup).not.toContain('<b>');
    const next = formatDateTimeValue('2026-10-09T10:05:00.000Z', 'en');
    expect(markup).toContain(translations.t('auth_files.refresh_failing_next', { time: next }));
  });

  test('renders nothing for a healthy credential', () => {
    expect(
      renderToStaticMarkup(createElement(AuthFileRefreshFailure, { file: normalize({}) }))
    ).toBe('');
  });
});
