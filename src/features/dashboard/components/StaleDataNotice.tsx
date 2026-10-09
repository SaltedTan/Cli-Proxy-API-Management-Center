import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import styles from './StaleDataNotice.module.scss';

export interface StaleDataNoticeProps {
  t: TFunction;
  locale: string;
  /** When the data shown was loaded; omitted when unknown. */
  updatedAtMs?: number;
  now: number;
  /** Omitted hides the retry button. */
  onRetry?: () => void;
  retrying?: boolean;
  /** Accessible name of the retry button, naming what it reloads. */
  retryLabel: string;
}

/** Says that the last refresh failed and how old the data still shown is. */
export function StaleDataNotice({
  t,
  locale,
  updatedAtMs,
  now,
  onRetry,
  retrying = false,
  retryLabel,
}: StaleDataNoticeProps) {
  // The panel clock ticks coarsely and may trail the load time; clamped into the past so
  // the text never reads "in 1 minute" (a zero gap counts as future).
  const text =
    updatedAtMs === undefined
      ? t('dashboard.refresh_failed')
      : t('dashboard.refresh_stale', {
          time: formatRelativeInstant(Math.min(updatedAtMs, now - 1), now, locale),
        });
  return (
    <p className={styles.stale} role="status">
      <span
        title={updatedAtMs === undefined ? undefined : new Date(updatedAtMs).toLocaleString(locale)}
      >
        {text}
      </span>
      {onRetry && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.retry}
          onClick={onRetry}
          loading={retrying}
          aria-label={retryLabel}
        >
          {t('dashboard.refresh_retry')}
        </Button>
      )}
    </p>
  );
}
