import { normalizeRoutingStrategy, ROUTING_STRATEGIES } from '@/features/dashboard/routing';
import type { RoutingStrategy, VisualConfigValidationErrorCode } from '@/types/visualConfig';
import { goDurationSeconds } from './visualConfigAdditions';

/** Every strategy the backend knows is selectable in the editor. */
export const VISUAL_ROUTING_STRATEGIES: readonly RoutingStrategy[] = ROUTING_STRATEGIES;

/**
 * Maps a configured strategy name or alias to its canonical name. Unknown names show as
 * round-robin, which is what the backend routes with for them.
 */
export function parseVisualRoutingStrategy(raw: unknown): RoutingStrategy {
  const normalized = normalizeRoutingStrategy(String(raw ?? ''));
  return VISUAL_ROUTING_STRATEGIES.find((strategy) => strategy === normalized) ?? 'round-robin';
}

/**
 * The backend parses the TTL with Go's time.ParseDuration and silently runs the 1h
 * default for an invalid or non-positive value, so reject those before saving. Blank
 * keeps the default. Like other backend-tolerated durations, an untouched existing
 * value does not block unrelated edits.
 */
export function sessionAffinityTTLError(
  value: string,
  dirtyFields?: ReadonlySet<string>
): VisualConfigValidationErrorCode | undefined {
  if (dirtyFields && !dirtyFields.has('routingSessionAffinityTTL')) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = goDurationSeconds(trimmed);
  if (seconds === undefined) return 'invalid_duration';
  return seconds > 0 ? undefined : 'positive_duration';
}
