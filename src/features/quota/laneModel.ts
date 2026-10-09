/**
 * Lanes: can a credential take a request for a model right now, and what stops it?
 *
 * Claude gates every request on account-wide windows (the 5-hour session and
 * the 7-day limit), and some models on a scoped weekly limit of their own
 * (Fable). The proxy draws the same line: an exhausted scoped limit pauses only
 * that model on the credential, an exhausted account-wide one benches the whole
 * credential (CLIProxyAPI's classifyClaudeUpstreamError, the Fable `7d_oi` case).
 *
 * So a model's lane is gated by the account-wide windows plus its own, and the
 * lane for every other model by the account-wide windows alone. A lane reads its
 * own limit unless another gate stops it sooner — one already empty or paused by
 * the proxy, or one projected to run out before its reset. Percentages of
 * different windows are never blended (41% of the 7-day limit is not 41% of
 * Fable), so a lane names the window that decides it instead.
 *
 * Quota is not the only gate: the proxy never selects a disabled credential or
 * one it marked unavailable (CLIProxyAPI's isAuthBlockedForModel), whatever its
 * cached quota says. Such a lane is unavailable, and its quota stays readable.
 *
 * Pure and clock-free like paceModel.ts: `nowMs` is always passed in.
 */

import { getAuthFileStatusMessage, hasAuthFileStatusWarning } from '@/features/authFiles/constants';
import type { AuthFileCooldownSnapshot, AuthFileItem } from '@/types/authFile';
import { isDisabledAuthFile } from '@/utils/quota/validators';
import { MINUTE_MS } from '@/utils/time/durations';
import type { CredentialBlock, LedgerPause, LedgerSnapshot, LedgerWindow } from './ledgerModel';
import { computeWindowPace } from './paceModel';

export type LaneStatus = 'open' | 'tight' | 'closed' | 'unavailable' | 'unknown';

/** Lane id for every model without a limit of its own. */
export const OTHER_MODELS_LANE_ID = 'other-models';

/**
 * Only a window at least this long can take a lane over on a projection. A
 * 5-hour session's projection swings with every request, and an empty session
 * refills within hours, so it decides a lane only once it is actually empty.
 */
export const TAKEOVER_MIN_PERIOD_HOURS = 24;

export interface QuotaLane {
  /** The model window's id, or OTHER_MODELS_LANE_ID. */
  id: string;
  /** Display name of the lane's model; null for the lane of every other model. */
  model: string | null;
  status: LaneStatus;
  /** The lane's own limit: the model's scoped window, or the longest account-wide one. */
  own: LedgerWindow;
  /** The window that decides the lane — `own` unless another gate stops it sooner. */
  gate: LedgerWindow;
  /** Running short: when `gate` empties at its cycle-average burn. */
  runoutAtMs: number | null;
  /** Closed: when every empty gate and pause has lifted; null when unknown. */
  reopenAtMs: number | null;
  /** The proxy pause that holds this lane, if any. */
  pause: LedgerPause | null;
  /** Unavailable: why the proxy will not select the credential at all. */
  block: CredentialBlock | null;
}

export interface LaneColumn {
  id: string;
  model: string | null;
}

/**
 * Projections are cycle averages; showing their run-out time to the minute would
 * claim a precision they lack, so they are shown to the nearest ten minutes.
 */
export const approximateInstant = (ms: number): number =>
  Math.round(ms / (10 * MINUTE_MS)) * 10 * MINUTE_MS;

export const isModelWindow = (window: Pick<LedgerWindow, 'scope' | 'model'>): boolean =>
  window.scope === 'scoped' && Boolean(window.model);

export const hasModelLanes = (snapshot: LedgerSnapshot | null): boolean =>
  snapshot?.windows.some(isModelWindow) ?? false;

/** "Fable 5.1" → "fable": the family a model key such as `claude-fable-5-1` contains. */
const modelFamily = (model: string) => model.trim().split(/\s+/)[0].toLowerCase();

/** The latest-lifting active pause that stops this lane: credential-wide, or its own model's. */
function pauseFor(
  model: string | null,
  pauses: readonly LedgerPause[] | undefined,
  nowMs: number
): LedgerPause | null {
  const family = model ? modelFamily(model) : null;
  const holding = (pauses ?? []).filter(
    (pause) =>
      pause.untilMs > nowMs &&
      (pause.scope === 'credential' ||
        (family !== null && (pause.modelKey ?? '').toLowerCase().includes(family)))
  );
  return holding.reduce<LedgerPause | null>(
    (latest, pause) => (latest === null || pause.untilMs > latest.untilMs ? pause : latest),
    null
  );
}

function decideLane(
  id: string,
  model: string | null,
  own: LedgerWindow,
  gates: readonly LedgerWindow[],
  pause: LedgerPause | null,
  block: CredentialBlock | null,
  nowMs: number
): QuotaLane {
  const base = { id, model, own, pause, block, runoutAtMs: null, reopenAtMs: null };

  // Nothing reopens a credential the proxy will not select; its quota is moot.
  if (block) return { ...base, status: 'unavailable', gate: own };

  const empty = gates.filter((gate) => gate.remaining !== null && gate.remaining <= 0);
  if (empty.length > 0 || pause) {
    // The empty gate that lifts last is the one the lane waits on.
    const gate =
      empty.length > 0
        ? empty.reduce((last, next) =>
            (next.resetAtMs ?? Infinity) > (last.resetAtMs ?? Infinity) ? next : last
          )
        : own;
    const resets = empty.map((window) => window.resetAtMs);
    const reopenAtMs = resets.some((reset) => reset === null)
      ? null
      : Math.max(...(resets as number[]), pause?.untilMs ?? -Infinity);
    return {
      ...base,
      status: 'closed',
      gate,
      reopenAtMs: reopenAtMs !== null && reopenAtMs > nowMs ? reopenAtMs : null,
    };
  }

  let first: { gate: LedgerWindow; atMs: number } | null = null;
  for (const gate of gates) {
    if (gate !== own && (gate.periodHours ?? 0) < TAKEOVER_MIN_PERIOD_HOURS) continue;
    const pace = computeWindowPace(gate, nowMs);
    if (pace.status !== 'over' || pace.early || pace.exhaustedAtMs === null) continue;
    if (first === null || pace.exhaustedAtMs < first.atMs) {
      first = { gate, atMs: pace.exhaustedAtMs };
    }
  }
  if (first) return { ...base, status: 'tight', gate: first.gate, runoutAtMs: first.atMs };

  return { ...base, status: own.remaining === null ? 'unknown' : 'open', gate: own };
}

/**
 * One lane per model-scoped window, then one for every other model. The
 * latter's own limit is the longest account-wide window (the 7-day limit);
 * without any account-wide window there is nothing to gate it on, so no lane.
 */
export function buildQuotaLanes(snapshot: LedgerSnapshot, nowMs: number): QuotaLane[] {
  const account = snapshot.windows.filter((window) => window.scope === 'account');
  const lanes = snapshot.windows
    .filter(isModelWindow)
    .map((window) =>
      decideLane(
        window.id,
        window.model ?? null,
        window,
        [...account, window],
        pauseFor(window.model ?? null, snapshot.pauses, nowMs),
        snapshot.block ?? null,
        nowMs
      )
    );

  const longest = account.reduce<LedgerWindow | null>(
    (best, window) =>
      best === null || (window.periodHours ?? 0) > (best.periodHours ?? 0) ? window : best,
    null
  );
  if (longest) {
    lanes.push(
      decideLane(
        OTHER_MODELS_LANE_ID,
        null,
        longest,
        account,
        pauseFor(null, snapshot.pauses, nowMs),
        snapshot.block ?? null,
        nowMs
      )
    );
  }
  return lanes;
}

/** Shared lane columns for a group: model lanes in first-seen order, then the rest. */
export function buildLaneColumns(snapshots: readonly (LedgerSnapshot | null)[]): LaneColumn[] {
  const columns = new Map<string, LaneColumn>();
  for (const snapshot of snapshots) {
    for (const window of snapshot?.windows ?? []) {
      if (isModelWindow(window) && !columns.has(window.id)) {
        columns.set(window.id, { id: window.id, model: window.model ?? null });
      }
    }
  }
  return [...columns.values(), { id: OTHER_MODELS_LANE_ID, model: null }];
}

/**
 * The proxy's active cooldowns as pauses. The deadline is anchored to when the
 * list arrived plus the server-measured remaining time — never `retry_at`
 * against the local wall clock (see cooldownRemainingSeconds).
 */
export function ledgerPausesFromCooldowns(
  snapshot: AuthFileCooldownSnapshot | undefined
): LedgerPause[] {
  if (!snapshot) return [];
  return (snapshot.records ?? [])
    .filter((record) => record.remainingSeconds > 0)
    .map((record) => ({
      scope: record.scope,
      modelKey: record.scope === 'model' ? (record.modelKey ?? null) : null,
      untilMs: snapshot.receivedAtMs + record.remainingSeconds * 1000,
    }));
}

/**
 * Whether the proxy refuses the credential outright, from the auth-file list.
 *
 * The list reconciles `unavailable` against the selector: it stays set for a
 * persistent authentication failure (an expired or rejected token) and for an
 * active credential-wide cooldown. The cooldown already shows as a pause with
 * an end, so only an unavailable credential without one counts as blocked.
 */
export function credentialBlockFromAuthFile(
  file: AuthFileItem,
  pauses: readonly LedgerPause[]
): CredentialBlock | null {
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  if (isDisabledAuthFile(file) || status === 'disabled') {
    return { reason: 'disabled', message: null };
  }
  if (file.unavailable !== true) return null;
  if (pauses.some((pause) => pause.scope === 'credential')) return null;
  return {
    reason: 'unavailable',
    message: hasAuthFileStatusWarning(file) ? getAuthFileStatusMessage(file) : null,
  };
}
