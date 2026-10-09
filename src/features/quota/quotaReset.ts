import type { TFunction } from 'i18next';
import { apiClient } from '@/services/api';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores/useQuotaStore';
import type { AuthFileItem, NotificationType } from '@/types';
import { getStatusFromError, QuotaReadAfterResetError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getQuotaSetter, type QuotaAdapter } from './providers';

/**
 * Run a confirmed quota reset and commit its result.
 *
 * A reset that succeeds has also cleared the proxy's cooldowns on the
 * credential, which the auth-file listing keeps reporting until it is fetched
 * again, so the listing is reloaded as well. That holds even when only the
 * quota read after the reset failed: the reset is reported as done and the
 * card shows the read error. Nothing is committed or reloaded
 * once the session or the management connection changed mid-flight: the result
 * describes the previous connection.
 */
export async function runQuotaReset(
  adapter: QuotaAdapter,
  file: AuthFileItem,
  t: TFunction,
  notify: (message: string, type: NotificationType) => void,
  reloadFiles: () => void
): Promise<void> {
  const resetQuotaFn = adapter.resetQuota;
  if (!resetQuotaFn) return;
  const cacheKey = getQuotaCacheKey(file);
  const cacheGeneration = captureQuotaCacheGeneration(file.name);
  const connectionRevision = apiClient.getConnectionRevision();
  const setQuota = getQuotaSetter(adapter);
  try {
    const data = await resetQuotaFn(file, t);
    if (connectionRevision !== apiClient.getConnectionRevision()) return;
    commitIfQuotaCacheCurrent(cacheGeneration, () => {
      setQuota((prev) => ({
        ...prev,
        [cacheKey]: adapter.buildSuccessState(data),
      }));
      notify(t('codex_quota.reset_success', { name: file.name }), 'success');
      reloadFiles();
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : t('common.unknown_error');
    if (err instanceof QuotaReadAfterResetError) {
      if (connectionRevision !== apiClient.getConnectionRevision()) return;
      commitIfQuotaCacheCurrent(cacheGeneration, () => {
        setQuota((prev) => ({
          ...prev,
          [cacheKey]: adapter.buildErrorState(message, getStatusFromError(err.readError)),
        }));
        notify(
          t('codex_quota.reset_success_refresh_failed', { name: file.name, message }),
          'warning'
        );
        reloadFiles();
      });
      return;
    }
    commitIfQuotaCacheCurrent(cacheGeneration, () => {
      notify(t('codex_quota.reset_failed', { name: file.name, message }), 'error');
    });
  }
}
