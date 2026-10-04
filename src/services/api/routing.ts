import { apiClient } from './client';
import type {
  RoutingCounters,
  RoutingDecision,
  RoutingObservability,
  RoutingSessionAffinityState,
} from '@/types/routing';

const ROUTING_OBSERVABILITY_TIMEOUT_MS = 15 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const toCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const toOptionalCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const toTimeMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  // Go encodes an unset time.Time as year 1; treat it as unknown.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const optionalText = (value: unknown): string | undefined => toText(value) || undefined;

const normalizeDecision = (raw: unknown): RoutingDecision | null => {
  if (!isRecord(raw)) return null;
  const authIndex = toText(raw.auth_index);
  if (!authIndex) return null;
  return {
    timeMs: toTimeMs(raw.time),
    provider: toText(raw.provider),
    model: toText(raw.model),
    authIndex,
    selection: toText(raw.selection) || 'strategy',
    strategyReason: optionalText(raw.strategy_reason),
    candidates: toOptionalCount(raw.candidates),
    attempt: Math.max(1, toCount(raw.attempt)),
    attemptKind: toText(raw.attempt_kind) || 'initial',
    previousAuthIndex: optionalText(raw.previous_auth_index),
    session: optionalText(raw.session),
    transport: optionalText(raw.transport),
  };
};

const normalizeCounters = (raw: unknown): RoutingCounters => {
  const source = isRecord(raw) ? raw : {};
  return {
    selections: toCount(source.selections),
    retries: toCount(source.retries),
    failovers: toCount(source.failovers),
    affinityHits: toCount(source.affinity_hits),
    affinityNew: toCount(source.affinity_new),
    affinityRebinds: toCount(source.affinity_rebinds),
    transportWebsocket: toCount(source.transport_websocket),
    transportHttp: toCount(source.transport_http),
  };
};

const normalizeSessionAffinity = (raw: unknown): RoutingSessionAffinityState => {
  const source = isRecord(raw) ? raw : {};
  const sessionsByAuthIndex: Record<string, number> = {};
  if (isRecord(source.sessions_by_auth_index)) {
    Object.entries(source.sessions_by_auth_index).forEach(([authIndex, count]) => {
      const key = authIndex.trim();
      const value = toCount(count);
      if (key && value > 0) sessionsByAuthIndex[key] = value;
    });
  }
  return {
    enabled: source.enabled === true,
    ttlSeconds: toOptionalCount(source.ttl_seconds) || undefined,
    subagents: typeof source.subagents === 'boolean' ? source.subagents : undefined,
    activeSessions: toCount(source.active_sessions),
    sessionsByAuthIndex,
  };
};

export const normalizeRoutingObservability = (raw: unknown): RoutingObservability => {
  const source = isRecord(raw) ? raw : {};
  const recent = Array.isArray(source.recent)
    ? source.recent
        .map(normalizeDecision)
        .filter((decision): decision is RoutingDecision => decision !== null)
    : [];
  return {
    observedAtMs: toTimeMs(source.observed_at),
    sinceMs: toTimeMs(source.since),
    mode: toText(source.mode) || 'local',
    strategy: toText(source.strategy),
    pluginScheduler: source.plugin_scheduler === true,
    sessionAffinity: normalizeSessionAffinity(source.session_affinity),
    counters: normalizeCounters(source.counters),
    recent,
  };
};

export const routingApi = {
  getObservability: async (): Promise<RoutingObservability> => {
    const raw = await apiClient.get<unknown>('/observability/routing', {
      timeout: ROUTING_OBSERVABILITY_TIMEOUT_MS,
    });
    return normalizeRoutingObservability(raw);
  },
};
