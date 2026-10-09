import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import i18n from '@/i18n';
import { classifyOAuthCallbackError } from '@/services/api/oauthCallbackError';

// Shaped like the ApiError that apiClient builds from an axios failure.
const apiError = (status: number | undefined, data: unknown, message = 'Request failed') =>
  Object.assign(new Error(message), { name: 'ApiError', status, data, details: data });

describe('OAuth callback errors', () => {
  test('an unknown or expired login asks to start the login again', () => {
    const failure = classifyOAuthCallbackError(
      apiError(
        404,
        { status: 'error', error: 'unknown or expired state' },
        'unknown or expired state'
      )
    );
    expect(failure).toEqual({ kind: 'restart', message: 'unknown or expired state' });

    const translations = i18n.cloneInstance({ lng: 'en' });
    const text = translations.t('auth_login.oauth_callback_restart_hint', {
      message: 'unknown or expired state',
    });
    expect(text).toContain('unknown or expired state');
    expect(text).not.toContain('update CLI Proxy API');
  });

  test('a bare 404 from a server without the endpoint keeps the upgrade hint', () => {
    expect(classifyOAuthCallbackError(apiError(404, '404 page not found'))).toEqual({
      kind: 'upgrade',
    });
    expect(classifyOAuthCallbackError(apiError(404, undefined))).toEqual({ kind: 'upgrade' });
    expect(classifyOAuthCallbackError(apiError(404, { status: 'error' }))).toEqual({
      kind: 'upgrade',
    });
  });

  test('other failures keep their message', () => {
    expect(
      classifyOAuthCallbackError(
        apiError(
          409,
          { error: 'oauth flow is already completed' },
          'oauth flow is already completed'
        )
      )
    ).toEqual({ kind: 'other', message: 'oauth flow is already completed' });
    expect(classifyOAuthCallbackError('offline')).toEqual({ kind: 'other', message: 'offline' });
  });

  test('the OAuth page no longer treats every 404 as an outdated server', () => {
    const source = readFileSync(new URL('../src/pages/OAuthPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('classifyOAuthCallbackError(err)');
    expect(source).toContain("t('auth_login.oauth_callback_restart_hint'");
    expect(source).not.toContain('status === 404');
  });
});
