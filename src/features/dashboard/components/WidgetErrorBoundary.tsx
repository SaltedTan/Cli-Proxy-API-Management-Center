import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import dash from '../dashboard.module.scss';
import styles from './WidgetErrorBoundary.module.scss';

export interface WidgetErrorBoundaryProps {
  /** The widget's visible title, named in the error card. */
  name: string;
  children: ReactNode;
}

interface WidgetErrorBoundaryState {
  failed: boolean;
}

/**
 * Contains a render error in one dashboard widget, so the rest of the page and the
 * authenticated layout stay usable. Retry renders the widget again from scratch.
 */
export class WidgetErrorBoundary extends Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  state: WidgetErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): WidgetErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Dashboard widget "${this.props.name}" failed to render:`, error, info);
  }

  retry = () => {
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return <WidgetErrorCard name={this.props.name} onRetry={this.retry} />;
  }
}

export function WidgetErrorCard({ name, onRetry }: { name: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={dash.panel} role="alert">
      <div className={styles.card}>
        <p className={styles.message}>{t('dashboard.widget_error', { name })}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onRetry}
          aria-label={t('dashboard.widget_error_retry_label', { name })}
        >
          {t('dashboard.refresh_retry')}
        </Button>
      </div>
    </div>
  );
}
