/**
 * Interval polling that pauses while the page is hidden, like the logs feature's
 * auto-refresh: a tick that finds the tab hidden is skipped, and one poll runs when the
 * tab becomes visible again so the data is not an interval old. Timer and visibility
 * sources are injectable so tests never touch a real clock or document.
 */

export interface VisiblePollingOptions {
  intervalMs: number;
  poll: () => void;
  isHidden?: () => boolean;
  /** Calls `listener` whenever visibility changes; returns the unsubscribe. */
  onVisibilityChange?: (listener: () => void) => () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const documentHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const onDocumentVisibilityChange = (listener: () => void) => {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

/** Starts polling; returns the function that stops it. */
export function startVisiblePolling({
  intervalMs,
  poll,
  isHidden = documentHidden,
  onVisibilityChange = onDocumentVisibilityChange,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id as ReturnType<typeof setInterval>),
}: VisiblePollingOptions): () => void {
  let missed = false;
  const timer = setTimer(() => {
    if (isHidden()) {
      missed = true;
      return;
    }
    poll();
  }, intervalMs);
  const unsubscribe = onVisibilityChange(() => {
    if (!missed || isHidden()) return;
    missed = false;
    poll();
  });
  return () => {
    clearTimer(timer);
    unsubscribe();
  };
}
