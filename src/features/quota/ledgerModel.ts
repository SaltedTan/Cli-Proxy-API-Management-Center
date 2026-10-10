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

import type { QuotaWindowScope } from '@/types';
import { CLAUDE_CLOUD_SESSION_CREDITS_ID } from '@/utils/quota';
import { buildQuotaLanes, isModelWindow, type QuotaLane } from './laneModel';
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
  /** What an exhausted window stops; absent for providers that don't say. */
  scope?: QuotaWindowScope;
  /** Display name of the model a scoped window limits — such a window gets a ledger lane. */
  model?: string | null;
  /**
   * What this window's 100% is worth when pooled across credentials, in the
   * provider's unit: Claude's 5-hour limit counts Pro sessions, so a Max 20x
   * window weighs 20, and its 7-day and Fable limits Pro weeks, where it weighs 10.
   * Absent = unweighted, pooled as 100% like every other.
   */
  weight?: number;
  /** The weight is a stand-in (plan unknown, so one unit), not read from the plan. */
  weightAssumed?: boolean;
}

/**
 * A routing pause the proxy holds on the credential (one of its cooldowns),
 * anchored to the local clock when the auth-file list arrived.
 */
export interface LedgerPause {
  scope: 'credential' | 'model';
  /** The paused model's key for model-scoped pauses, e.g. `claude-fable-5-1`. */
  modelKey: string | null;
  untilMs: number;
}

/**
 * Why the proxy will not select the credential at all, apart from a pause: it
 * is disabled, or the proxy marked it unavailable (an expired or rejected
 * token, say). Its cached quota stays readable, but it serves nothing.
 */
export interface CredentialBlock {
  reason: 'disabled' | 'unavailable';
  /** The proxy's status message, when it gave a meaningful one. */
  message: string | null;
}

export interface LedgerSnapshot {
  plan: string | null;
  /** Headline window first. */
  windows: LedgerWindow[];
  /**
   * The proxy's active pauses on this credential, joined in from the auth-file
   * list; null when the proxy did not report them, so none can be ruled out.
   */
  pauses?: LedgerPause[] | null;
  /** Set when the proxy will not select the credential; joined in from the auth-file list. */
  block?: CredentialBlock | null;
}

export const EMPTY_LEDGER: LedgerSnapshot = { plan: null, windows: [] };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/**
 * A percentage as shown: whole numbers, except that a sliver is never rounded
 * into an empty or a full window. 0.4% left reads "<1", not "0" — which would
 * say used up while requests still go through. Models keep the exact figure;
 * only display rounds.
 */
export const displayPercent = (value: number): string =>
  value > 0 && value < 1 ? '<1' : value > 99 && value < 100 ? '>99' : String(Math.round(value));

export const formatPercent = (value: number | null): string =>
  value === null ? '--' : `${displayPercent(value)}%`;

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
  scope?: QuotaWindowScope;
  model?: string | null;
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
          ...(window.scope ? { scope: window.scope } : {}),
          ...(window.model ? { model: window.model } : {}),
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
  /** Sum of remaining percent over credentials that report it, unrounded; null when none do. */
  totalRemaining: number | null;
  /**
   * 100 per credential that reports this window or is not loaded yet — the pool
   * if every one of them were untouched. Loaded credentials without the window
   * (a Claude account with no model-scoped limit) are not part of its pool.
   * A weighted line counts differently; see `weighting`.
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
  /**
   * Set when the column's windows carry weights. The total and capacity are
   * then in weight units × 100 — `remaining × weight` and `100 × weight` per
   * loaded credential. A credential not loaded yet is left out of the pool,
   * segments included: its weight is unknown until it loads, and a bar drawn
   * against this capacity must not hold room the capacity does not count.
   */
  weighting?: {
    /** One per segment, in the same order. */
    weights: number[];
    /** Loaded credentials whose weight is a stand-in for an unknown plan. */
    assumed: number;
  };
  /**
   * Loaded credentials counted as empty because a longer account-wide limit is
   * used up (see `summarizeProvider`); absent when there are none. Only
   * weighted and model-scoped lines are gated.
   */
  gated?: number;
}

/** A model's own limit, pooled, plus whether its lanes can take a request now. */
export interface ProviderModelSummary {
  line: ProviderSummaryLine;
  model: string;
  /** Loaded credentials that carry this model's limit. */
  carrying: number;
  /**
   * Of those, how many could serve the model right now (lane open or running
   * short). An unavailable credential or an unknown lane never counts.
   */
  serving: number;
  /** Of those, how many serve only some of the model's ids: the proxy paused the others. */
  partial: number;
  /** Of those, how many cannot be told: a gate without a figure, or unreported pauses. */
  unknown: number;
  /** Of those, how many are projected to stop before their refill. */
  short: number;
  /** The earliest projected stop among them. */
  firstStopMs: number | null;
}

export interface ProviderSummary {
  credentialCount: number;
  loadedCount: number;
  headline: ProviderSummaryLine | null;
  /** Model-scoped limits that get a lane in the ledger, in column order. */
  models: ProviderModelSummary[];
  /** Weighted pools other than the headline (Claude's 5-hour limit), in column order. */
  weighted: ProviderSummaryLine[];
  /** Remaining columns, longest window first. */
  secondary: ProviderSummaryLine[];
}

/**
 * The credential's other limits that take `window`'s allowance out of the pool
 * until they reset. Account-wide and used up mean what they do for laneModel's
 * empty gates (`scope === 'account'`, nothing left), so the strip and the lanes
 * agree; a used-up reading whose reset has passed has already reset. The gate
 * must also be at least as long as `window`: a shorter one — Claude's 5-hour
 * session beside the weekly Fable limit — refills before the window's own
 * allowance would, so it closes a lane for a while but takes nothing from the
 * pool. A limit of unknown length gates, as it would close a lane.
 */
const usedUpGates = (snapshot: LedgerSnapshot, window: LedgerWindow, nowMs: number) =>
  snapshot.windows.filter(
    (gate) =>
      gate.id !== window.id &&
      gate.scope === 'account' &&
      gate.remaining !== null &&
      gate.remaining <= 0 &&
      (gate.resetAtMs === null || gate.resetAtMs > nowMs) &&
      (gate.periodHours === null ||
        window.periodHours === null ||
        gate.periodHours >= window.periodHours)
  );

/**
 * When a gated credential's share of the pool next grows, by the proxy's own
 * rule (the weekly-blocked branch of combineWindow in internal/keyusage/pool.go):
 * nothing is usable before the gate lifts at `gateLiftMs`. If the window (the
 * 5-hour session, or Fable) will not have reset by then, its unused part comes
 * back at the lift and its used part at the window's own reset; otherwise all
 * of it comes back at the lift.
 * A top-up that restores nothing is no top-up. Null when none is known.
 */
const gatedTopUpMs = (
  remaining: number | null,
  ownResetMs: number | null,
  gateLiftMs: number | null
): number | null => {
  if (gateLiftMs === null) return null;
  if (remaining !== null && remaining < 100 && (ownResetMs === null || ownResetMs > gateLiftMs)) {
    const topUps = [
      ...(remaining > 0 ? [gateLiftMs] : []),
      ...(ownResetMs !== null ? [ownResetMs] : []),
    ];
    return topUps.length > 0 ? Math.min(...topUps) : null;
  }
  return gateLiftMs;
};

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
 * secondary line instead. Scoped windows never headline while an account-wide
 * one exists: the headline pools a limit that gates every request. Claude's
 * cloud session credits never headline beside an actual limit.
 *
 * A model-scoped window (one with a ledger lane) is summarized as a model block
 * rather than a secondary line, so it can say how many credentials could serve
 * the model now — which its own percentage cannot (see laneModel.ts).
 *
 * A column whose windows carry weights pools in their unit instead, so a Max
 * 20x session counts twenty Pro sessions rather than one more 100%, and leaves
 * out credentials not loaded yet, whose share is unknown. It is listed apart
 * from the folded secondary lines (see `ProviderSummaryLine.weighting`).
 *
 * In a weighted pool or a model-scoped line, a credential that has used up a
 * longer account-wide limit (Claude's 7-day) cannot spend any of the window
 * until that limit resets, however full the window reads — an exhausted Max
 * 20x often shows an untouched 5-hour session and plenty of Fable. It keeps its
 * place in capacity (its weight, or 100), adds nothing left, draws an empty
 * segment and has no pace; it next tops up when the gate lifts, or later when
 * its window is spent and resets after that (see `gatedTopUpMs`), and never as
 * far as the pool can tell when the gate's reset is unknown. This matches the
 * proxy's own key-usage pools (internal/keyusage/pool.go), which pool the
 * 5-hour, weekly and Fable figures the same way. Other lines report each window as is.
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
    // Unweighted windows weigh 1, which leaves the sums exactly as they were.
    // Null marks a credential not loaded yet, which a weighted pool leaves out.
    const weights: (number | null)[] = [];
    let weighted = false;
    let weightedCapacity = 0;
    let assumed = 0;
    let gated = 0;
    for (const snapshot of snapshots) {
      if (snapshot === null) {
        segments.push(null);
        weights.push(null);
        continue;
      }
      const window = snapshot.windows.find((candidate) => candidate.id === column.id);
      if (!window) continue;
      const weight = window.weight ?? 1;
      if (window.weight !== undefined) weighted = true;
      if (window.weightAssumed) assumed += 1;
      weights.push(weight);
      weightedCapacity += 100 * weight;
      coverage += 1;
      const gateable = window.weight !== undefined || isModelWindow(window);
      const gates = gateable ? usedUpGates(snapshot, window, nowMs) : [];
      if (gates.length > 0) {
        gated += 1;
        segments.push(0);
        total = total ?? 0;
        // The gate that lifts last, as a lane waits on it; an unknown reset never lifts.
        const resets = gates.map((gate) => gate.resetAtMs);
        const liftMs = resets.includes(null) ? null : Math.max(...(resets as number[]));
        const topUpMs = gatedTopUpMs(window.remaining, window.resetAtMs, liftMs);
        if (topUpMs !== null && (nextResetMs === null || topUpMs < nextResetMs)) {
          nextResetMs = topUpMs;
        }
        continue;
      }
      segments.push(window.remaining);
      if (window.remaining !== null) total = (total ?? 0) + window.remaining * weight;
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
    const line: ProviderSummaryLine = {
      id: column.id,
      label: column.label,
      totalRemaining: total,
      capacity: segments.length * 100,
      segments,
      nextResetMs,
      coverage,
      pace,
      ...(gated > 0 ? { gated } : {}),
    };
    if (!weighted) return line;
    const pooled = (_: unknown, index: number) => weights[index] !== null;
    return {
      ...line,
      capacity: weightedCapacity,
      segments: segments.filter(pooled),
      weighting: {
        weights: weights.filter((weight): weight is number => weight !== null),
        assumed,
      },
    };
  });

  const columnFor = (line: ProviderSummaryLine) => columns.find((column) => column.id === line.id);
  // Claude's cloud session credits are a balance, not a limit: they headline
  // only when the provider reports nothing else.
  const limits = lines.filter((line) => line.id !== CLAUDE_CLOUD_SESSION_CREDITS_ID);
  const accountWide = limits.filter((line) => columnFor(line)?.scope !== 'scoped');
  // First line with the widest coverage; reduce keeps the earlier one on ties.
  const headline = (
    accountWide.length > 0 ? accountWide : limits.length > 0 ? limits : lines
  ).reduce<ProviderSummaryLine | null>(
    (best, line) => (best === null || line.coverage > best.coverage ? line : best),
    null
  );

  const lanesBySnapshot = snapshots.map((snapshot) =>
    snapshot === null ? [] : buildQuotaLanes(snapshot, nowMs)
  );
  const models = lines
    .filter((line) => line !== headline)
    .flatMap((line): ProviderModelSummary[] => {
      const column = columnFor(line);
      if (!column || !isModelWindow(column)) return [];
      const lanes = lanesBySnapshot
        .map((snapshotLanes) => snapshotLanes.find((lane) => lane.id === line.id))
        .filter((lane): lane is QuotaLane => lane !== undefined);
      const stops = lanes.flatMap((lane) => (lane.runoutAtMs !== null ? [lane.runoutAtMs] : []));
      return [
        {
          line,
          model: column.model as string,
          carrying: lanes.length,
          serving: lanes.filter((lane) => lane.status === 'open' || lane.status === 'tight').length,
          partial: lanes.filter((lane) => lane.status === 'partial').length,
          unknown: lanes.filter((lane) => lane.status === 'unknown').length,
          short: stops.length,
          firstStopMs: stops.length > 0 ? Math.min(...stops) : null,
        },
      ];
    });

  const rest = lines.filter(
    (line) => line !== headline && !models.some((model) => model.line === line)
  );
  const weighted = rest.filter((line) => line.weighting !== undefined);

  const period = (line: ProviderSummaryLine) => columnFor(line)?.periodHours ?? 0;
  // Stable: equal periods keep column order.
  const secondary = rest
    .filter((line) => line.weighting === undefined)
    .map((line, index) => ({ line, index }))
    .sort((a, b) => period(b.line) - period(a.line) || a.index - b.index)
    .map(({ line }) => line);

  return { credentialCount, loadedCount, headline, models, weighted, secondary };
}
