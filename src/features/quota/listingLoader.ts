/**
 * Auth-file listing loads for the quota page.
 *
 * Only the latest request commits. A background load keeps the current list
 * on screen and drops its failure silently. When it supersedes a foreground
 * load that is still pending, it takes over that load's loading state and
 * error reporting, so the foreground outcome is never lost.
 */

export interface ListingLoadRequest<T> {
  fetch: () => Promise<T>;
  /** False once the quota session changed; the response is then dropped. */
  isSessionCurrent: () => boolean;
  commit: (result: T) => void;
  setLoading: (loading: boolean) => void;
  /** Called with '' to clear the error. */
  setError: (message: string) => void;
  errorMessage: (err: unknown) => string;
  background?: boolean;
}

export interface ListingLoader {
  load: <T>(request: ListingLoadRequest<T>) => Promise<void>;
  /** Drops every in-flight load. */
  cancel: () => void;
}

export function createListingLoader(): ListingLoader {
  let latestRequestId = 0;
  let foregroundPending = false;

  const cancel = () => {
    latestRequestId += 1;
    foregroundPending = false;
  };

  const load = async <T>(request: ListingLoadRequest<T>) => {
    const requestId = ++latestRequestId;
    const isCurrent = () => requestId === latestRequestId && request.isSessionCurrent();
    const foreground = !request.background || foregroundPending;
    if (foreground) {
      foregroundPending = true;
      request.setLoading(true);
      request.setError('');
    }
    try {
      const result = await request.fetch();
      if (!isCurrent()) return;
      request.commit(result);
    } catch (err: unknown) {
      if (!isCurrent() || !foreground) return;
      request.setError(request.errorMessage(err));
    } finally {
      if (isCurrent()) {
        foregroundPending = false;
        request.setLoading(false);
      }
    }
  };

  return { load, cancel };
}
