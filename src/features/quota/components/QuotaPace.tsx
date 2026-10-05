/**
 * Pace on screen: the even-spend tick on a quota meter and the verdict line
 * under it. Shared by the ledger cells and the card bodies.
 *
 * Card bodies draw provider-shaped rows rather than ledger windows, so the host
 * (QuotaCardContent) provides the credential's ledger snapshot and each row
 * looks its window up by ledger id. The host also provides the class names:
 * bodies import no stylesheet, and outside a provider — the auth-file cards —
 * rows simply stay unpaced.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { formatRelativeInstant } from '@/utils/quota';
import type { LedgerSnapshot, LedgerWindow } from '../ledgerModel';
import { computeWindowPace, type KnownPace } from '../paceModel';
import type { PaceClassMap } from '../types';

interface PaceRowContext {
  windows: ReadonlyMap<string, LedgerWindow>;
  classes: PaceClassMap;
}

const QuotaPaceContext = createContext<PaceRowContext | null>(null);

export function QuotaPaceProvider({
  snapshot,
  classes,
  children,
}: {
  snapshot: LedgerSnapshot | null;
  classes: PaceClassMap;
  children: ReactNode;
}) {
  const value = useMemo(
    () =>
      snapshot
        ? { windows: new Map(snapshot.windows.map((window) => [window.id, window])), classes }
        : null,
    [snapshot, classes]
  );
  return <QuotaPaceContext.Provider value={value}>{children}</QuotaPaceContext.Provider>;
}

/** Known pace for a body row, or null outside a provider or without a trusted cycle. */
function useRowPace(paceId: string) {
  const context = useContext(QuotaPaceContext);
  const window = context?.windows.get(paceId) ?? null;
  const now = useNow(window !== null);
  if (!context || !window || window.remaining === null) return null;
  const pace = computeWindowPace(window, now);
  if (pace.status === 'unknown') return null;
  return { pace, remaining: window.remaining, now, classes: context.classes };
}

/** The even-spend tick, drawn over a meter. Decorative: the verdict line carries the reading. */
export function PaceMark({ pace, classes }: { pace: KnownPace; classes: PaceClassMap }) {
  return (
    <span
      className={classes.paceMark}
      style={{ left: `${pace.expectedRemaining}%` }}
      aria-hidden="true"
    />
  );
}

/** Wraps a body row's meter and adds the tick when the row's window has a known pace. */
export function PacedMeter({ paceId, children }: { paceId: string; children: ReactNode }) {
  const row = useRowPace(paceId);
  if (!row) return children;
  return (
    <div className={row.classes.meter}>
      {children}
      <PaceMark pace={row.pace} classes={row.classes} />
    </div>
  );
}

/** The verdict line for a body row; nothing when its pace is unknown. */
export function QuotaRowPace({ paceId }: { paceId: string }) {
  const row = useRowPace(paceId);
  return row ? <PaceVerdict {...row} /> : null;
}

/**
 * The pace verdict, plus when an over-pace window runs dry at its cycle-average
 * burn. Early in a cycle the projection is left out — a single request can make
 * it say "runs out in minutes".
 */
export function PaceVerdict({
  pace,
  remaining,
  now,
  classes,
  className,
}: {
  pace: KnownPace;
  remaining: number;
  now: number;
  classes: PaceClassMap;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const usedUp = remaining <= 0;
  const showRunout = pace.status === 'over' && !pace.early && pace.exhaustedAtMs !== null;
  const text = usedUp
    ? t('quota_management.pace_used_up')
    : showRunout
      ? t('quota_management.pace_over_runout', {
          relative: formatRelativeInstant(pace.exhaustedAtMs as number, now, i18n.resolvedLanguage),
        })
      : t(`quota_management.pace_${pace.status}`);
  const detail = t('quota_management.pace_detail', {
    used: Math.round(100 - remaining),
    elapsed: Math.round(pace.elapsedPercent),
  });
  const statusClass = usedUp
    ? classes.paceUsedUp
    : pace.status === 'over'
      ? classes.paceOver
      : pace.status === 'on'
        ? classes.paceOn
        : classes.paceUnder;

  return (
    <div
      className={[classes.pace, statusClass, className].filter(Boolean).join(' ')}
      title={detail}
    >
      <span className={classes.paceDot} aria-hidden="true" />
      <span className={classes.paceText}>{text}</span>
      <span className={classes.srOnly}>{detail}</span>
    </div>
  );
}
