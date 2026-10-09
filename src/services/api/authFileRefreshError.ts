import type { AuthFileRefreshError } from '@/types/authFile';
import { normalizeCooldownTimestamp } from './authFileCooldowns';

/**
 * Reads `refresh_error` and `next_refresh_after` from a credential listing entry.
 * The backend sends them only after a failed token refresh.
 */
export function normalizeAuthFileRefreshError(
  value: unknown,
  nextRefreshAfter: unknown
): AuthFileRefreshError | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const message = typeof entry.message === 'string' ? entry.message.trim() : '';
  const code = typeof entry.code === 'string' ? entry.code.trim() : '';
  const httpStatus = entry.http_status;
  const failedAt = normalizeCooldownTimestamp(entry.at);
  const nextAttempt = normalizeCooldownTimestamp(nextRefreshAfter);
  return {
    message,
    ...(code ? { code } : {}),
    ...(typeof httpStatus === 'number' &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
    ...(failedAt ? { failedAt } : {}),
    ...(nextAttempt ? { nextRefreshAfter: nextAttempt } : {}),
  };
}
