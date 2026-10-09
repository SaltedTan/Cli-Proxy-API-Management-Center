import type { AuthFileItem } from '@/types/authFile';
import { isRuntimeOnlyAuthFile } from './constants';

export type DeleteAllOutcome =
  | { kind: 'success' }
  | { kind: 'partial'; deleted: number; expected: number }
  /** The listing could not be reloaded; `deleted` is the server's count, if it sent one. */
  | { kind: 'unverified'; deleted: number | null };

/**
 * Judges "delete all credentials". The backend skips files it cannot remove and still
 * answers 200 with the `deleted` count, so compare against what was listed before and the
 * listing fetched afterwards. Runtime-only credentials have no file and are never deleted.
 *
 * The count alone proves nothing: it covers every removable file in the auth directory,
 * listed or not. Without a fresh listing the outcome is unverified.
 */
export function summarizeDeleteAll(
  before: AuthFileItem[],
  deleted: number | undefined,
  after: AuthFileItem[] | null
): DeleteAllOutcome {
  if (after === null) return { kind: 'unverified', deleted: deleted ?? null };
  const expected = before.filter((file) => !isRuntimeOnlyAuthFile(file)).length;
  const remaining = after.filter((file) => !isRuntimeOnlyAuthFile(file)).length;
  const removed = deleted ?? expected - remaining;
  return remaining > 0
    ? { kind: 'partial', deleted: Math.max(0, Math.min(removed, expected)), expected }
    : { kind: 'success' };
}
