import type { ApiError } from '@/types';
import { parseApiErrorResponse } from './apiError';

/**
 * A request with responseType 'blob' also receives its JSON error body as a Blob, so the
 * client can only report the transport message. Decode that body in place, like the log
 * downloads do, keeping the error's identity, status and transport code.
 */
export async function decodeBlobApiError(error: unknown): Promise<void> {
  if (!(error instanceof Error)) return;
  const apiError = error as ApiError;
  const body = apiError.data instanceof Blob ? apiError.data : apiError.details;
  if (!(body instanceof Blob)) return;
  try {
    const parsed = parseApiErrorResponse(JSON.parse(await body.text()), apiError.message);
    apiError.message = parsed.message;
    if (parsed.apiCode !== undefined) apiError.apiCode = parsed.apiCode;
  } catch {
    // Unreadable or non-JSON bodies must not mask the original failure.
  }
}
