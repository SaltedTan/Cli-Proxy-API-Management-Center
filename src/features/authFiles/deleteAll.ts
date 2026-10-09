import type { AuthFileItem } from '@/types/authFile';
import { isRuntimeOnlyAuthFile } from './constants';

export type DeleteAllOutcome =
  { kind: 'success' } | { kind: 'partial'; deleted: number; expected: number };

/**
 * Judges "delete all credentials". The backend skips files it cannot remove and still
 * answers 200 with the `deleted` count, so compare against what was listed before and,
 * when available, the listing fetched afterwards. Runtime-only credentials have no file
 * and are never deleted.
 */
export function summarizeDeleteAll(
  before: AuthFileItem[],
  deleted: number | undefined,
  after: AuthFileItem[] | null
): DeleteAllOutcome {
  const expected = before.filter((file) => !isRuntimeOnlyAuthFile(file)).length;
  const remaining = after?.filter((file) => !isRuntimeOnlyAuthFile(file)).length;
  const removed = deleted ?? (remaining === undefined ? expected : expected - remaining);
  const partial = remaining === undefined ? removed < expected : remaining > 0;
  return partial
    ? { kind: 'partial', deleted: Math.max(0, Math.min(removed, expected)), expected }
    : { kind: 'success' };
}
