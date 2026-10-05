import type { TFunction } from 'i18next';
import type { Config } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { RoutingCounters } from '@/types/routing';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import { normalizeAuthIndex } from '@/utils/authIndex';

export const ROUTING_STRATEGIES = [
  'round-robin',
  'weighted-round-robin',
  'fill-first',
  'quota-aware',
] as const;

export type KnownRoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

const STRATEGY_ALIASES: Record<string, KnownRoutingStrategy> = {
  'round-robin': 'round-robin',
  roundrobin: 'round-robin',
  rr: 'round-robin',
  'weighted-round-robin': 'weighted-round-robin',
  weightedroundrobin: 'weighted-round-robin',
  wrr: 'weighted-round-robin',
  'fill-first': 'fill-first',
  fillfirst: 'fill-first',
  ff: 'fill-first',
  'quota-aware': 'quota-aware',
  quotaaware: 'quota-aware',
  qa: 'quota-aware',
  'reset-priority': 'quota-aware',
};

/**
 * Mirrors the backend's strategy normalization: blank means the round-robin default,
 * unknown values return null (the backend silently runs round-robin for them).
 */
export function normalizeRoutingStrategy(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'round-robin';
  return STRATEGY_ALIASES[value] ?? null;
}

const STRATEGY_LABEL_KEYS: Record<KnownRoutingStrategy, string> = {
  'round-robin': 'dashboard.routing_strategy_round_robin',
  'weighted-round-robin': 'dashboard.routing_strategy_weighted_round_robin',
  'fill-first': 'dashboard.routing_strategy_fill_first',
  'quota-aware': 'dashboard.routing_strategy_quota_aware',
};

/** Returns the i18n key for a strategy, or null when the value should be shown raw. */
export function routingStrategyLabelKey(strategy: string | undefined | null): string | null {
  const normalized = normalizeRoutingStrategy(strategy);
  if (!normalized || !(normalized in STRATEGY_LABEL_KEYS)) return null;
  return STRATEGY_LABEL_KEYS[normalized as KnownRoutingStrategy];
}

export type StrategyDrift =
  | { kind: 'none' }
  | { kind: 'unrecognized'; configured: string }
  | { kind: 'differs'; configured: string };

/**
 * Compares the configured strategy with the one the running selector reports.
 * `custom` selectors are embedder-provided, so they are never flagged as drift.
 */
export function detectStrategyDrift(
  configured: string | undefined | null,
  effective: string | undefined | null
): StrategyDrift {
  const running = (effective ?? '').trim();
  if (!running || running === 'custom') return { kind: 'none' };
  const raw = (configured ?? '').trim();
  const normalized = normalizeRoutingStrategy(raw);
  if (normalized === null) return { kind: 'unrecognized', configured: raw };
  if (normalized !== running) return { kind: 'differs', configured: raw || normalized };
  return { kind: 'none' };
}

export interface RoutingPoolSummary {
  total: number;
  ready: number;
  /** Not blocked as a whole, but with at least one active model or credential cooldown. */
  cooling: number;
  unavailable: number;
  disabled: number;
  /** Earliest active cooldown among enabled credentials, with its backend reason. */
  nextRecovery: { seconds: number; reason: string } | null;
  /** False when the backend did not report cooldown state for any credential. */
  cooldownsReported: boolean;
}

export function summarizeRoutingPool(files: AuthFileItem[], nowMs: number): RoutingPoolSummary {
  const summary: RoutingPoolSummary = {
    total: files.length,
    ready: 0,
    cooling: 0,
    unavailable: 0,
    disabled: 0,
    nextRecovery: null,
    cooldownsReported: false,
  };

  files.forEach((file) => {
    if (file.disabled) {
      summary.disabled += 1;
      return;
    }

    let cooling = false;
    const snapshot = file.cooldownSnapshot;
    if (snapshot) {
      summary.cooldownsReported = true;
      const { rows } = summarizeCooldowns(snapshot, nowMs);
      rows.forEach(({ record, remainingSeconds }) => {
        if (remainingSeconds <= 0) return;
        cooling = true;
        if (!summary.nextRecovery || remainingSeconds < summary.nextRecovery.seconds) {
          summary.nextRecovery = { seconds: remainingSeconds, reason: record.reason };
        }
      });
    }

    if (file.unavailable) {
      summary.unavailable += 1;
    } else if (cooling) {
      summary.cooling += 1;
    } else {
      summary.ready += 1;
    }
  });

  return summary;
}

/** Countdown estimates round up so a remaining 61s never reads as 1m. */
export function formatRoutingDuration(t: TFunction, seconds: number): string {
  if (seconds < 60) return t('auth_files.cooldown_seconds', { count: seconds });
  if (seconds < 3600) return t('auth_files.cooldown_minutes', { count: Math.ceil(seconds / 60) });
  return t('auth_files.cooldown_hours', { count: Math.ceil(seconds / 3600) });
}

/** TTLs are configured values, so render them exactly instead of rounding up. */
export function formatRoutingTtl(t: TFunction, seconds: number): string {
  if (seconds % 3600 === 0) return t('auth_files.cooldown_hours', { count: seconds / 3600 });
  if (seconds % 60 === 0) return t('auth_files.cooldown_minutes', { count: seconds / 60 });
  return t('auth_files.cooldown_seconds', { count: seconds });
}

/** Share of session-bound selections that reused an existing binding; null without data. */
export function affinityReuseRate(counters: RoutingCounters): number | null {
  const total = counters.affinityHits + counters.affinityNew + counters.affinityRebinds;
  return total > 0 ? (counters.affinityHits / total) * 100 : null;
}

const hostOf = (baseUrl: string | undefined): string => {
  const value = (baseUrl ?? '').trim();
  if (!value) return '';
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
};

/**
 * Maps auth indexes to display names. Auth files use their account email or file
 * name; when several share that name (one email in several teams), each gets its
 * organization name, or a short auth index when that does not tell them apart.
 * Configured keys use their provider, prefix or base URL host, plus their
 * position when a group holds several keys. API key values are never used as labels.
 */
export function buildCredentialLabels(
  files: AuthFileItem[] | null,
  config: Config | null
): Map<string, string> {
  const labels = new Map<string, string>();
  const add = (index: unknown, label: string) => {
    const key = normalizeAuthIndex(index);
    const value = label.trim();
    if (key && value && !labels.has(key)) labels.set(key, value);
  };
  const numbered = (label: string, position: number, size: number) =>
    size > 1 ? `${label} #${position + 1}` : label;

  const fileEntries = (files ?? []).map((file) => ({
    authIndex: normalizeAuthIndex(file.authIndex),
    base: String(file.email ?? '').trim() || file.name,
    organization: String(file.organizationName ?? '').trim(),
  }));
  const tally = (keys: string[]) => {
    const counts = new Map<string, number>();
    keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
    return counts;
  };
  const baseCounts = tally(fileEntries.map(({ base }) => base.toLowerCase()));
  const organizationCounts = tally(
    fileEntries.map(({ base, organization }) => `${base}\0${organization}`.toLowerCase())
  );
  fileEntries.forEach(({ authIndex, base, organization }) => {
    if ((baseCounts.get(base.toLowerCase()) ?? 0) < 2) {
      add(authIndex, base);
      return;
    }
    const sharedOrganization =
      !organization || (organizationCounts.get(`${base}\0${organization}`.toLowerCase()) ?? 0) > 1;
    const qualifiers = [
      organization,
      sharedOrganization && authIndex ? `#${shortAuthIndex(authIndex)}` : '',
    ].filter(Boolean);
    add(authIndex, qualifiers.length > 0 ? `${base} · ${qualifiers.join(' · ')}` : base);
  });

  if (config) {
    const groups: Array<{
      provider: string;
      entries: Array<{ authIndex?: string; prefix?: string; baseUrl?: string }>;
    }> = [
      { provider: 'gemini', entries: config.geminiApiKeys ?? [] },
      { provider: 'interactions', entries: config.interactionsApiKeys ?? [] },
      { provider: 'codex', entries: config.codexApiKeys ?? [] },
      { provider: 'claude', entries: config.claudeApiKeys ?? [] },
      { provider: 'vertex', entries: config.vertexApiKeys ?? [] },
      { provider: 'xai', entries: config.xaiApiKeys ?? [] },
      { provider: 'meta', entries: config.metaApiKeys ?? [] },
    ];
    groups.forEach(({ provider, entries }) => {
      entries.forEach((entry, position) => {
        const detail = entry.prefix?.trim() || hostOf(entry.baseUrl);
        add(
          entry.authIndex,
          numbered(detail ? `${provider} · ${detail}` : provider, position, entries.length)
        );
      });
    });

    // OpenAI-compatible providers carry one auth index per key entry.
    (config.openaiCompatibility ?? []).forEach((provider) => {
      const name = provider.name?.trim() || hostOf(provider.baseUrl) || 'openai';
      const entries = provider.apiKeyEntries ?? [];
      entries.forEach((entry, position) => {
        add(entry.authIndex, numbered(name, position, entries.length));
      });
      add(provider.authIndex, name);
    });
  }

  return labels;
}

/** Shortened auth index used when no friendlier label is known. */
export const shortAuthIndex = (authIndex: string): string =>
  authIndex.length > 10 ? authIndex.slice(0, 8) : authIndex;

const SELECTION_LABEL_KEYS: Record<string, string> = {
  strategy: 'dashboard.routing_selection_strategy',
  affinity_hit: 'dashboard.routing_selection_affinity_hit',
  affinity_new: 'dashboard.routing_selection_affinity_new',
  affinity_rebind: 'dashboard.routing_selection_affinity_rebind',
  pinned: 'dashboard.routing_selection_pinned',
  plugin: 'dashboard.routing_selection_plugin',
};

export const routingSelectionLabelKey = (selection: string): string =>
  SELECTION_LABEL_KEYS[selection] ?? 'dashboard.routing_selection_strategy';

export type RoutingTone = 'good' | 'warning' | 'critical' | 'neutral';

/** Rebinds and failovers are the events an operator usually needs to notice. */
export const routingSelectionTone = (selection: string): RoutingTone => {
  if (selection === 'affinity_hit') return 'good';
  if (selection === 'affinity_rebind') return 'warning';
  return 'neutral';
};

export const routingAttemptTone = (attemptKind: string): RoutingTone => {
  if (attemptKind === 'failover') return 'critical';
  if (attemptKind === 'retry') return 'warning';
  return 'neutral';
};

const QUOTA_REASON_KEYS: Record<string, string> = {
  weekly_pace: 'dashboard.routing_quota_reason_weekly_pace',
  no_weekly_data: 'dashboard.routing_quota_reason_no_weekly_data',
  no_weekly_quota_left: 'dashboard.routing_quota_reason_no_weekly_quota_left',
  probe_no_weekly_data: 'dashboard.routing_quota_reason_probe_no_weekly_data',
};

/** Quota-aware reasons may carry a `,all_short_saturated` suffix. */
export function quotaReasonLabelKeys(reason: string | undefined): string[] {
  if (!reason) return [];
  return reason
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part === 'all_short_saturated'
        ? 'dashboard.routing_quota_reason_all_short_saturated'
        : (QUOTA_REASON_KEYS[part] ?? '')
    )
    .filter(Boolean);
}
