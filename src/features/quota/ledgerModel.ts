/**
 * Quota ledger: one flat row per credential, and a rollup per provider.
 *
 * The ledger is a scanning surface — every credential on one line, every quota
 * window in its own column — so unlike resetSchedule.ts and
 * quotaTimelineModel.ts it does flatten the provider shapes into one window
 * model. That is lossy on purpose: billing amounts, reset credits and group
 * descriptions stay in the provider body, which a ledger row expands to.
 *
 * Pure and clock-free: provider extractors live beside each provider
 * (`providers/<type>/ledger.ts`) and `nowMs` is always passed in.
 */

import { computeWindowPace, type PaceCounts } from './paceModel';

/** One quota window, normalized to "percent remaining". */
export interface LedgerWindow {
  /** Stable within a provider, so rows can line up in shared columns. */
  id: string;
  label: string;
  /** Remaining percent, 0..100; null when the provider reported no figure. */
  remaining: number | null;
  resetAtMs: number | null;
  /** Pre-formatted reset text for providers that only expose a hint. */
  resetLabel: string | null;
  /** Window length in hours; orders the summary's secondary lines. */
  periodHours: number | null;
  /**
   * The client guessed `periodHours` (a billing month taken as 30 days) rather
   * than reading it from the payload. Good enough to order columns; not good
   * enough to pace against, so such windows get no pace.
   */
  periodEstimated?: boolean;
}

export interface LedgerSnapshot {
  plan: string | null;
  /** Headline window first. */
  windows: LedgerWindow[];
}

export const EMPTY_LEDGER: LedgerSnapshot = { plan: null, windows: [] };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** Most providers report percent USED; the ledger reads percent remaining. */
export const remainingFromUsed = (used: number | null | undefined): number | null =>
  isFiniteNumber(used) ? clampPercent(100 - used) : null;

export const usableMs = (value: number | null | undefined): number | null =>
  isFiniteNumber(value) ? value : null;

/**
 * Move the preferred window ids to the front, in the given order; everything
 * else keeps its incoming order. The first window is the provider's headline.
 */
export function orderLedgerWindows<T extends { id: string }>(
  windows: readonly T[],
  preferredIds: readonly string[]
): T[] {
  const rank = (window: T) => {
    const index = preferredIds.indexOf(window.id);
    return index === -1 ? preferredIds.length : index;
  };
  return windows
    .map((window, index) => ({ window, index }))
    .sort((a, b) => rank(a.window) - rank(b.window) || a.index - b.index)
    .map(({ window }) => window);
}

/* ---------------------------------------------------------------- columns */

export interface LedgerColumn {
  id: string;
  label: string;
  periodHours: number | null;
}

/**
 * Shared columns for a group of rows: every window id in first-seen order.
 *
 * Credentials of one provider usually expose the same windows, but not always
 * (one Claude account may carry a model-scoped weekly limit another lacks).
 * Columns are keyed by id so a missing window leaves a gap in the right place
 * instead of shifting the rest of the row left.
 */
export function buildLedgerColumns(snapshots: readonly (LedgerSnapshot | null)[]): LedgerColumn[] {
  const columns = new Map<string, LedgerColumn>();
  for (const snapshot of snapshots) {
    for (const window of snapshot?.windows ?? []) {
      if (!columns.has(window.id)) {
        columns.set(window.id, {
          id: window.id,
          label: window.label,
          periodHours: window.periodHours,
        });
      }
    }
  }
  return [...columns.values()];
}

/* ---------------------------------------------------------------- summary */

export interface ProviderSummaryLine {
  id: string;
  label: string;
  /** Sum of remaining percent over credentials that report it; null when none do. */
  totalRemaining: number | null;
  /**
   * 100 per credential that reports this window or is not loaded yet — the pool
   * if every one of them were untouched. Loaded credentials without the window
   * (a Claude account with no model-scoped limit) are not part of its pool.
   */
  capacity: number;
  /** One entry per pooled credential, in row order; null = no figure yet. */
  segments: (number | null)[];
  /** Soonest reset still in the future, across credentials. */
  nextResetMs: number | null;
  /** Loaded credentials that report this window. */
  coverage: number;
  /** Credentials per pace verdict; windows without a known pace are not counted. */
  pace: PaceCounts;
}

export interface ProviderSummary {
  credentialCount: number;
  loadedCount: number;
  headline: ProviderSummaryLine | null;
  /** Remaining columns, longest window first. */
  secondary: ProviderSummaryLine[];
}

/**
 * Roll a provider's credentials up into pooled lines, one per column.
 *
 * `snapshots` holds one entry per credential — null when its quota is not
 * loaded — so unloaded credentials still count towards capacity and still get
 * an (empty) segment. A pool that reads "17% of 300%" with two blank segments
 * is honest about how much of it is unknown.
 *
 * The headline is the window reported by the most loaded credentials, ties
 * broken by column order. A limit only some accounts carry (Claude's
 * model-scoped weekly window on a subset of subscriptions) would otherwise
 * headline a pool that leaves most of the provider out; it stays visible as a
 * secondary line instead.
 */
export function summarizeProvider(
  snapshots: readonly (LedgerSnapshot | null)[],
  nowMs: number
): ProviderSummary {
  const credentialCount = snapshots.length;
  const loadedCount = snapshots.filter((snapshot) => snapshot !== null).length;
  const columns = buildLedgerColumns(snapshots);

  const lines = columns.map((column): ProviderSummaryLine => {
    let total: number | null = null;
    let nextResetMs: number | null = null;
    let coverage = 0;
    const segments: (number | null)[] = [];
    const pace: PaceCounts = { over: 0, on: 0, under: 0 };
    for (const snapshot of snapshots) {
      if (snapshot === null) {
        segments.push(null);
        continue;
      }
      const window = snapshot.windows.find((candidate) => candidate.id === column.id);
      if (!window) continue;
      coverage += 1;
      segments.push(window.remaining);
      if (window.remaining !== null) total = (total ?? 0) + window.remaining;
      const windowPace = computeWindowPace(window, nowMs);
      if (windowPace.status !== 'unknown') pace[windowPace.status] += 1;
      if (
        window.resetAtMs !== null &&
        window.resetAtMs > nowMs &&
        (nextResetMs === null || window.resetAtMs < nextResetMs)
      ) {
        nextResetMs = window.resetAtMs;
      }
    }
    return {
      id: column.id,
      label: column.label,
      totalRemaining: total === null ? null : Math.round(total),
      capacity: segments.length * 100,
      segments,
      nextResetMs,
      coverage,
      pace,
    };
  });

  // First line with the widest coverage; reduce keeps the earlier one on ties.
  const headline = lines.reduce<ProviderSummaryLine | null>(
    (best, line) => (best === null || line.coverage > best.coverage ? line : best),
    null
  );
  const period = (line: ProviderSummaryLine) =>
    columns.find((column) => column.id === line.id)?.periodHours ?? 0;
  // Stable: equal periods keep column order.
  const secondary = lines
    .filter((line) => line !== headline)
    .map((line, index) => ({ line, index }))
    .sort((a, b) => period(b.line) - period(a.line) || a.index - b.index)
    .map(({ line }) => line);

  return { credentialCount, loadedCount, headline, secondary };
}
