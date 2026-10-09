import { providersApi } from '@/services/api';
import type { RawConfigSection } from '@/types/config';

export interface RefreshProviderConfigOptions {
  fetchConfig: (forceRefresh: boolean) => Promise<unknown>;
  updateConfigValue: (section: RawConfigSection, value: unknown) => void;
  /** False once a newer refresh or another management connection owns the store. */
  isCurrent: () => boolean;
}

/**
 * Reloads the full config plus the provider lists served by dedicated endpoints.
 * Returns false without publishing anything when the refresh was superseded.
 */
export async function refreshProviderConfig({
  fetchConfig,
  updateConfigValue,
  isCurrent,
}: RefreshProviderConfigOptions): Promise<boolean> {
  const [configResult, vertexResult, openaiResult] = await Promise.allSettled([
    fetchConfig(true),
    providersApi.getVertexConfigs(),
    providersApi.getOpenAIProviders(),
  ]);
  if (!isCurrent()) return false;
  if (configResult.status !== 'fulfilled') {
    throw configResult.reason;
  }
  if (vertexResult.status === 'fulfilled') {
    updateConfigValue('vertex-api-key', vertexResult.value || []);
  }
  if (openaiResult.status === 'fulfilled') {
    updateConfigValue('openai-compatibility', openaiResult.value || []);
  }
  return true;
}
