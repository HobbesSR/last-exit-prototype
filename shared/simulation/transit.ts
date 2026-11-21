import { TILE } from '../movement.ts';
import { distance } from './geometry.ts';
import { TRANSIT_REACH } from './rules.ts';
import { phaseSix, STEP_TRANSIT } from './phase-six.ts';
import type { Game, Player, Station, StationId, Vec2 } from '../types.ts';

// Gladiator transit between stations (12 "Transit route selection", 14, #692).

/** The rail cooldown, started on landing; the core's arrival (`rust/core/src/phase_one.rs`) receives it. */
export const RAIL_COOLDOWN = 180;

/**
 * Where `p` may transit to now: from the station within reach, to every other station ahead of the wall.
 * `next` is where plain interact goes, the first of them past `p`. Null when `p` can't transit. The client
 * offers the same list, so both read this one rule.
 */
export function transitOptions(s: Pick<Game, 'map' | 'hazardX'>, p: Player): { from: Station; ahead: Station[]; next: Station } | null {
  if (p.role !== 'gladiator' || p.status !== 'active' || p.railCd !== 0) return null;
  const from = s.map.stations.find(st => distance(p, st) < TRANSIT_REACH);
  if (!from) return null;
  const ahead = s.map.stations.filter(st => st.x > s.hazardX + TILE && st.id !== from.id);
  const next = ahead.find(st => st.x > p.x + TILE) ?? ahead[0];
  return next ? { from, ahead, next } : null;
}

/** Ticks a transit to `to` takes under the content: zero, the default, is instant. */
export function transitTicks(s: Game, from: Vec2, to: Vec2): number {
  const time = s.content.transitTime;
  return time ? Math.max(0, Math.round(time.base + time.perUnit * distance(from, to))) : 0;
}

/**
 * Transit `p` to the station `choice` names, or without one to the next station ahead. A destination
 * that is unknown, behind the wall or the current station is refused with no effect and no cooldown,
 * as is a landing the physics world cannot place. It runs in the core (`rust/core/src/phase_six.rs`, #1230), which
 * holds the same options as `transitOptions` and the same time as `transitTicks`; this is its entry for scenarios.
 */
export function transit(s: Game, p: Player, choice?: StationId): void {
  phaseSix(s, [{ player: p, steps: STEP_TRANSIT, choice }], false);
}
