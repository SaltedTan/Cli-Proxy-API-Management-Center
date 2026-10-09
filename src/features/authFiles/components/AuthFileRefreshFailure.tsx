import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { AuthFileItem } from '@/types/authFile';
import { formatDateTimeValue } from '@/utils/format';
import {
  describeAuthFileRefreshFailure,
  getAuthFileRefreshFailure,
} from '@/features/authFiles/refreshFailure';
import styles from './AuthFileRefreshFailure.module.scss';

/** Shows a failing token refresh, which the backend keeps out of status_message. */
export function AuthFileRefreshFailure({ file }: { file: AuthFileItem }) {
  const { t, i18n } = useTranslation();
  const failure = getAuthFileRefreshFailure(file);
  if (!failure) return null;
  const detail = describeAuthFileRefreshFailure(failure) || t('auth_files.refresh_failing_unknown');
  const failedAt = formatDateTimeValue(failure.failedAt, i18n.language);
  const nextAttempt = formatDateTimeValue(failure.nextRefreshAfter, i18n.language);
  return (
    <div className={styles.section}>
      <div className={styles.head}>
        <IconRefreshCw className={styles.icon} size={13} />
        <span className={styles.label}>{t('auth_files.refresh_failing')}</span>
      </div>
      <p className={styles.detail} title={detail}>
        {detail}
      </p>
      {(failedAt || nextAttempt) && (
        <p className={styles.times}>
          {failedAt && <span>{t('auth_files.refresh_failing_at', { time: failedAt })}</span>}
          {nextAttempt && (
            <span>{t('auth_files.refresh_failing_next', { time: nextAttempt })}</span>
          )}
        </p>
      )}
    </div>
  );
}
