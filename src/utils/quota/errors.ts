/**
 * Quota error message resolution shared by the quota page and auth-files cards.
 */

import type { TFunction } from 'i18next';

/** 配额接口错误 → 用户可读文案（404=后端需升级，403=检查凭证）。 */
export const resolveQuotaErrorMessage = (
  t: TFunction,
  status: number | undefined,
  fallback: string
): string => {
  if (status === 404) return t('common.quota_update_required');
  if (status === 403) return t('common.quota_check_credential');
  return fallback;
};

/**
 * A quota reset that was confirmed, including its cooldown clear, but whose
 * follow-up quota read failed. The reset itself succeeded and must not be
 * reported as failed; `readError` is the read's own error.
 */
export class QuotaReadAfterResetError extends Error {
  readonly readError: unknown;

  constructor(readError: unknown) {
    super(readError instanceof Error ? readError.message : String(readError));
    this.name = 'QuotaReadAfterResetError';
    this.readError = readError;
  }
}
