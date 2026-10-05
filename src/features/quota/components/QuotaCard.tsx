/**
 * 额度卡片：头部（提供商图标 + mono 文件名）+ 四态 body + 动作 footer。
 *
 * - idle：整个 body 是一个点击加载按钮（上游直连有速率考虑，不自动拉取）；
 * - loading：双幽灵行骨架（aria-busy，文字等价视觉隐藏）；
 * - error：失败色条 + footer 刷新即重试；
 * - success：provider Body（穿 QuotaBody.module.scss 全页外衣）。
 *
 * body + footer 拆为 QuotaCardContent：账本视图的行展开详情复用同一份
 * provider 细节与重置动作，不重复实现。
 *
 * 传入账本快照时，body 的每个窗口行带上节奏刻度与判词（见 QuotaPace.tsx）。
 */

import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { maskEmailsInText } from '../maskEmail';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { bindPaceClasses, bindQuotaClasses } from '../types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import type { LedgerSnapshot } from '../ledgerModel';
import { QuotaPaceProvider } from './QuotaPace';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaCard.module.scss';
import paceModule from './QuotaPace.module.scss';

/** 额度页全页外衣：QuotaBody 模块绑定成类型化契约（缺键在模块初始化即抛）。 */
const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');
const paceStyles = bindPaceClasses(paceModule, 'QuotaPace.module.scss');

export type QuotaCardContentProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  /** Ledger view of a loaded quota; supplies the body rows' pace. */
  snapshot?: LedgerSnapshot | null;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
  /** 账本行自带刷新按钮，展开详情里不再重复。 */
  showRefresh?: boolean;
};

export type QuotaCardProps = Omit<QuotaCardContentProps, 'showRefresh'> & {
  resolvedTheme: ResolvedTheme;
  /** 首屏级联入场延迟；null = 不入场（切 tab / 翻页 / 刷新新挂载的卡片）。 */
  entranceDelayMs?: number | null;
  /** 页头「显示邮箱」关闭时为 true。 */
  maskEmails?: boolean;
};

export function QuotaCard(props: QuotaCardProps) {
  const { entry, resolvedTheme, entranceDelayMs, maskEmails = false, ...content } = props;
  const { t } = useTranslation();
  const file = entry.file;
  const rawName = getQuotaDisplayName(file);
  const displayName = maskEmails ? maskEmailsInText(rawName, file.email) : rawName;

  // 挂载时捕获一次延迟：后续 props 变 null 不影响本卡（React 19 禁渲染期读 ref）
  const [mountEntranceDelayMs] = useState<number | null>(entranceDelayMs ?? null);
  const entranceStyle =
    mountEntranceDelayMs === null
      ? undefined
      : ({ '--card-delay': `${mountEntranceDelayMs}ms` } as CSSProperties);

  const iconSrc = getAuthFileIcon(entry.type, resolvedTheme);
  const typeLabel = getTypeLabel(t, entry.type);

  return (
    <article
      className={`${styles.card} ${mountEntranceDelayMs === null ? '' : styles.cardEnter}`}
      style={entranceStyle}
    >
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          title={typeLabel}
          style={
            isThemeSurfaceIconProvider(entry.type)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className={styles.fileName} title={displayName}>
          {displayName}
        </span>
      </header>

      <QuotaCardContent entry={entry} {...content} />
    </article>
  );
}

export function QuotaCardContent(props: QuotaCardContentProps) {
  const {
    entry,
    quota,
    snapshot = null,
    canRefresh,
    resetting,
    onRefresh,
    onReset,
    showRefresh = true,
  } = props;
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));
  const hasActions = entry.type === 'claude' || showReset || showRefresh;

  return (
    <>
      <div className={styles.body}>
        {entry.type === 'claude' && status === 'success' && (
          <>
            <div className={quotaClasses.codexPlan}>
              <span className={quotaClasses.codexPlanItem}>
                <span className={quotaClasses.codexPlanLabel}>{t('claude_reset.remaining')}</span>
                <span className={quotaClasses.codexPlanValue}>{claudeReset.count ?? '--'}</span>
              </span>
            </div>
            {claudeReset.message && (
              <div role="status" className={quotaClasses.codexResetCreditsError}>
                {t(`claude_reset.${claudeReset.message}`)}
              </div>
            )}
          </>
        )}
        {status === 'idle' ? (
          <button
            type="button"
            className={styles.idleBody}
            onClick={onRefresh}
            disabled={!canRefresh}
          >
            <IconRefreshCw size={15} aria-hidden="true" className={styles.idleGlyph} />
            <span className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</span>
          </button>
        ) : loading ? (
          <div className={styles.skeleton} aria-busy="true">
            <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
            {[0, 1].map((row) => (
              <div key={row} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonLabel} />
                <span className={styles.skeletonTrack} />
              </div>
            ))}
          </div>
        ) : status === 'error' ? (
          <div className={styles.errorStrip} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
          </div>
        ) : quota ? (
          <QuotaPaceProvider snapshot={snapshot} classes={paceStyles}>
            <adapter.Body quota={quota} classes={quotaClasses} />
          </QuotaPaceProvider>
        ) : (
          <div className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</div>
        )}
      </div>

      {status !== 'idle' && hasActions && (
        <footer className={styles.actionRow}>
          {entry.type === 'claude' && (
            <button
              type="button"
              className={styles.actionPill}
              disabled={claudeReset.blocked}
              onClick={claudeReset.confirm}
              title={t(`claude_reset.${claudeReset.buttonLabel}`)}
            >
              <IconRefreshCw size={13} className={claudeReset.busy ? styles.spinning : undefined} />
              {t(`claude_reset.${claudeReset.buttonLabel}`)}
            </button>
          )}
          {showReset && (
            <button
              type="button"
              className={styles.actionPill}
              onClick={onReset}
              disabled={!canRefresh || loading || resetting}
              title={t('codex_quota.reset_button')}
            >
              <IconRefreshCw size={13} className={resetting ? styles.spinning : undefined} />
              {t('codex_quota.reset_button')}
            </button>
          )}
          {showRefresh && (
            <button
              type="button"
              className={styles.actionPill}
              onClick={onRefresh}
              disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
              title={t('auth_files.quota_refresh_hint')}
            >
              <IconRefreshCw size={13} className={loading ? styles.spinning : undefined} />
              {t('auth_files.quota_refresh_single')}
            </button>
          )}
        </footer>
      )}
    </>
  );
}
