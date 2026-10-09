import type { AuthFileItem, AuthFileRefreshError } from '@/types/authFile';

/**
 * Returns the last failed token refresh to show on an enabled credential. Disabled
 * credentials are not refreshed, so their record is stale. This is informational only:
 * a credential whose refreshes fail stays out of the "problem" set used for bulk deletes,
 * because the backend keeps serving it while its access token is valid.
 */
export function getAuthFileRefreshFailure(file: AuthFileItem): AuthFileRefreshError | null {
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  if (file.disabled === true || status === 'disabled') return null;
  return file.refreshError ?? null;
}

/** Plain-text detail for a refresh failure; empty when the backend sent nothing usable. */
export function describeAuthFileRefreshFailure(error: AuthFileRefreshError): string {
  if (error.message) return error.message;
  const parts = [error.httpStatus ? `HTTP ${error.httpStatus}` : '', error.code ?? ''];
  return parts.filter(Boolean).join(' · ');
}
