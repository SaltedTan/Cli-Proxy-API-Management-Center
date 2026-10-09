import { getErrorMessage, isRecord } from '@/utils/helpers';

export type OAuthCallbackFailure =
  /** The backend has no such login, usually because it expired; start the login again. */
  | { kind: 'restart'; message: string }
  /** 404 without a backend error body: the server predates the callback endpoint. */
  | { kind: 'upgrade' }
  | { kind: 'other'; message: string };

const backendErrorText = (data: unknown): string => {
  if (!isRecord(data)) return '';
  const value = typeof data.message === 'string' ? data.message : data.error;
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Classifies a failed POST /oauth/callback. The backend answers an unknown or expired
 * login with 404 and a JSON error, while a server without the endpoint answers a bare 404.
 */
export function classifyOAuthCallbackError(error: unknown): OAuthCallbackFailure {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
  if (status === 404) {
    const message = backendErrorText(isRecord(error) ? error.data : undefined);
    return message ? { kind: 'restart', message } : { kind: 'upgrade' };
  }
  return { kind: 'other', message: getErrorMessage(error) };
}
