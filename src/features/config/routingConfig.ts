import { normalizeRoutingStrategy, ROUTING_STRATEGIES } from '@/features/dashboard/routing';
import type { RoutingStrategy } from '@/types/visualConfig';

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
