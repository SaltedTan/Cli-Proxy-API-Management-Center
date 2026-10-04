/**
 * 额度提供商适配器 = 数据层（data.ts，React-free）+ 渲染体（*QuotaBody.tsx）。
 *
 * 页面侧以擦除泛型的 QuotaAdapter 视图统一消费（与 AuthFileQuotaSection 的
 * 窄接口 cast 同一模式）；具体状态类型由各 data.ts 的强类型导出承载。
 */

import type { ComponentType } from 'react';
import type { TFunction } from 'i18next';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import type { QuotaBodyProps } from '../types';
import type { LedgerSnapshot } from '../ledgerModel';
import type { QuotaProviderType, QuotaStore } from './types';
import { ANTIGRAVITY_CONFIG } from './antigravity/data';
import { AntigravityQuotaBody } from './antigravity/AntigravityQuotaBody';
import { buildAntigravityLedger } from './antigravity/ledger';
import { CLAUDE_CONFIG } from './claude/data';
import { ClaudeQuotaBody } from './claude/ClaudeQuotaBody';
import { buildClaudeLedger } from './claude/ledger';
import { DEVIN_CONFIG } from './devin/data';
import { DevinQuotaBody } from './devin/DevinQuotaBody';
import { buildDevinLedger } from './devin/ledger';
import { CODEX_CONFIG } from './codex/data';
import { CodexQuotaBody } from './codex/CodexQuotaBody';
import { buildCodexLedger } from './codex/ledger';
import { META_CONFIG } from './meta/data';
import { MetaQuotaBody } from './meta/MetaQuotaBody';
import { buildMetaLedger } from './meta/ledger';
import { KIMI_CONFIG } from './kimi/data';
import { KimiQuotaBody } from './kimi/KimiQuotaBody';
import { buildKimiLedger } from './kimi/ledger';
import { XAI_CONFIG } from './xai/data';
import { XaiQuotaBody } from './xai/XaiQuotaBody';
import { buildXaiLedger } from './xai/ledger';

/** 所有 provider 额度状态的公共骨架（各 *QuotaState 的结构子集）。 */
export interface QuotaCardState {
  status: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  errorStatus?: number;
}

export interface QuotaAdapter {
  type: QuotaProviderType;
  i18nPrefix: string;
  filterFn: (file: AuthFileItem) => boolean;
  fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
  enrichQuota?: (file: AuthFileItem, data: unknown, t: TFunction) => Promise<unknown>;
  resetQuota?: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
  canResetQuota?: (quota: QuotaCardState) => boolean;
  storeSelector: (state: QuotaStore) => Record<string, QuotaCardState>;
  storeSetter: keyof QuotaStore;
  buildLoadingState: () => QuotaCardState;
  buildSuccessState: (data: unknown) => QuotaCardState;
  buildErrorState: (message: string, status?: number) => QuotaCardState;
  Body: ComponentType<QuotaBodyProps<QuotaCardState>>;
  /** Flat window view for the ledger; called only for `status === 'success'`. */
  ledger: (quota: QuotaCardState, t: TFunction) => LedgerSnapshot;
}

export const QUOTA_ADAPTERS: Record<QuotaProviderType, QuotaAdapter> = {
  antigravity: {
    ...ANTIGRAVITY_CONFIG,
    Body: AntigravityQuotaBody,
    ledger: buildAntigravityLedger,
  } as unknown as QuotaAdapter,
  claude: {
    ...CLAUDE_CONFIG,
    Body: ClaudeQuotaBody,
    ledger: buildClaudeLedger,
  } as unknown as QuotaAdapter,
  codex: {
    ...CODEX_CONFIG,
    Body: CodexQuotaBody,
    ledger: buildCodexLedger,
  } as unknown as QuotaAdapter,
  devin: {
    ...DEVIN_CONFIG,
    Body: DevinQuotaBody,
    ledger: buildDevinLedger,
  } as unknown as QuotaAdapter,
  kimi: { ...KIMI_CONFIG, Body: KimiQuotaBody, ledger: buildKimiLedger } as unknown as QuotaAdapter,
  meta: { ...META_CONFIG, Body: MetaQuotaBody, ledger: buildMetaLedger } as unknown as QuotaAdapter,
  xai: { ...XAI_CONFIG, Body: XaiQuotaBody, ledger: buildXaiLedger } as unknown as QuotaAdapter,
};

export type QuotaMapUpdater = (
  updater: (prev: Record<string, QuotaCardState>) => Record<string, QuotaCardState>
) => void;

/** 取 adapter 对应的 store setter（getState 直读，不建立订阅）。 */
export const getQuotaSetter = (adapter: QuotaAdapter): QuotaMapUpdater =>
  useQuotaStore.getState()[adapter.storeSetter] as unknown as QuotaMapUpdater;

/** 取 adapter 对应的额度缓存快照（getState 直读，不建立订阅）。 */
export const getQuotaMap = (adapter: QuotaAdapter): Record<string, QuotaCardState> =>
  adapter.storeSelector(useQuotaStore.getState() as unknown as QuotaStore);
