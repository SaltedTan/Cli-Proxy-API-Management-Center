/**
 * Live routing observability reported by `GET /observability/routing`.
 * Field names are normalized to camelCase at the API boundary.
 */

export type RoutingSelectionKind =
  'strategy' | 'affinity_hit' | 'affinity_new' | 'affinity_rebind' | 'pinned' | 'plugin';

export type RoutingAttemptKind = 'initial' | 'retry' | 'failover';

export type RoutingTransport = 'websocket' | 'http';

export interface RoutingDecision {
  /** Epoch milliseconds; null when the backend sent an unparseable time. */
  timeMs: number | null;
  provider: string;
  model: string;
  authIndex: string;
  selection: RoutingSelectionKind | string;
  strategyReason?: string;
  /** Ready credentials the selector chose among; absent when not measured. */
  candidates?: number;
  attempt: number;
  attemptKind: RoutingAttemptKind | string;
  previousAuthIndex?: string;
  /** Short non-reversible session fingerprint. */
  session?: string;
  transport?: RoutingTransport | string;
}

export interface RoutingCounters {
  selections: number;
  retries: number;
  failovers: number;
  affinityHits: number;
  affinityNew: number;
  affinityRebinds: number;
  transportWebsocket: number;
  transportHttp: number;
}

export interface RoutingSessionAffinityState {
  enabled: boolean;
  ttlSeconds?: number;
  subagents?: boolean;
  activeSessions: number;
  sessionsByAuthIndex: Record<string, number>;
}

export interface RoutingObservability {
  observedAtMs: number | null;
  sinceMs: number | null;
  /** `home` when selection is delegated to CLIProxyAPIHome. */
  mode: 'local' | 'home' | string;
  strategy: string;
  pluginScheduler: boolean;
  sessionAffinity: RoutingSessionAffinityState;
  counters: RoutingCounters;
  recent: RoutingDecision[];
}
