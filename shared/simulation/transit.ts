import { TILE } from '../movement.ts';
import { clearRoute, distance } from './geometry.ts';
import { TRANSIT_REACH } from './rules.ts';
import { effect } from './event-records.ts';
import { physicsRuntime } from './physics-runtime.ts';
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
 * as is a landing the physics world cannot place.
 */
export function transit(s: Game, p: Player, choice?: StationId): void {
  const options = transitOptions(s, p);
  const to = options && (choice === undefined ? options.next : options.ahead.find(st => st.id === choice));
  if (!to) return;
  const at = landing(s, p, to);
  if (!at) return;
  effect(s, p, 'rail', 60); clearRoute(p);
  const ticks = transitTicks(s, p, to);
  // In transit the gladiator is out of the world: not drawn, hit or acting, as every `active` check reads.
  // The state is what a later animation would show; the camera still cuts on landing.
  if (ticks > 0) { p.status = 'transit'; p.transit = { to: to.id, arriveAt: s.tick + ticks }; p.charging = null; p.input = {}; return; }
  land(s, p, at);
}

/**
 * Where `p` lands at `to`, or null while it can't be placed. A due transit's arrival runs in the core's phase 1
 * (`rust/core/src/phase_one.rs`), which asks this, and waits a tick when it is null.
 */
export function landing(s: Game, p: Player, to: Station): Vec2 | null {
  const runtime = physicsRuntime(s);
  return runtime ? runtime.placement(p, to) : to;
}
// The cooldown starts on landing.
function land(s: Game, p: Player, at: Vec2): void {
  p.x = at.x; p.y = at.y; p.railCd = RAIL_COOLDOWN; effect(s, p, 'rail', 60);
}
