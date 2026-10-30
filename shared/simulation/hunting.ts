import { movementSpeed, TILE } from '../movement.ts';
import { portalGraphOf } from '../navigation/portal-graph.ts';
import { distance } from './geometry.ts';
import { HZ } from './rules.ts';
import { transitTicks } from './transit.ts';
import type { Game, Player, Station, Tick, Vec2, World } from '../types.ts';

// How a gladiator bot hunts with nothing seen (#683, 14 "Gladiator bots"): it sweeps regions ahead of the wall, and
// it takes transit when the trip to its goal is shorter that way. Bot-private, never projected or recorded.

/** Time a transit costs beyond its travel time: lining up on the station and landing. */
const TRANSIT_OVERHEAD = 3 * HZ;
/** Sweeping looks only at regions whose centre is at least this far ahead of the wall. */
const SWEEP_AHEAD: World = 600;
/** Each unit a region lies ahead of the wall counts this much against it: contestants are pushed toward the wall's side. */
const SWEEP_WALLWARD = 0.5;
/**
 * A region counts as swept on coming within this of its target, or after SWEEP_STALL without moving a tile: a trip
 * by transit walks away from the target first, so getting closer is not the test.
 */
const SWEEP_ARRIVE: World = 400, SWEEP_STALL = 10 * HZ;
/** A swept region is not swept again for this long. */
const SWEEP_REVISIT = 90 * HZ;

interface Sweep {
  /** The tick each region was last swept. */
  swept: Map<number, Tick>;
  region: number;
  target: Vec2 | null;
  /** Where the gladiator last stood a tile away from, and when. */
  moved: Vec2;
  progressed: Tick;
}
const sweeps = new WeakMap<Player, Sweep>();

/**
 * Where `p` sweeps next: a standable spot in the region, ahead of the wall and not swept lately, that is nearest
 * once each unit ahead of the wall is weighed in, leaving out regions the other gladiators are sweeping. Null on
 * a map without regions, or with none left.
 */
export function sweepTarget(s: Game, p: Player, stand: (centre: Vec2) => Vec2): Vec2 | null {
  const graph = portalGraphOf(s.map);
  if (!graph) return null;
  let sweep = sweeps.get(p);
  if (!sweep) sweeps.set(p, sweep = { swept: new Map(), region: -1, target: null, moved: { x: p.x, y: p.y }, progressed: s.tick });
  if (sweep.target) {
    if (distance(p, sweep.moved) > TILE) { sweep.moved = { x: p.x, y: p.y }; sweep.progressed = s.tick; }
    if (distance(p, sweep.target) < SWEEP_ARRIVE || s.tick - sweep.progressed > SWEEP_STALL) giveUpSweep(s, p);
    else return sweep.target;
  }
  const taken = new Set(s.players.filter(q => q !== p && q.role === 'gladiator' && q.status !== 'eliminated').map(q => sweeps.get(q)?.region));
  let best = -1, score = Infinity;
  graph.regions.forEach((region, index) => {
    const centre = { x: region.box.x + region.box.w / 2, y: region.box.y + region.box.h / 2 };
    if (centre.x < s.hazardX + SWEEP_AHEAD || taken.has(index) || s.tick - (sweep!.swept.get(index) ?? -Infinity) < SWEEP_REVISIT) return;
    const value = distance(p, centre) + (centre.x - s.hazardX) * SWEEP_WALLWARD;
    if (value < score) { score = value; best = index; }
  });
  if (best < 0) return null;
  const box = graph.regions[best]!.box;
  Object.assign(sweep, { region: best, target: stand({ x: box.x + box.w / 2, y: box.y + box.h / 2 }), moved: { x: p.x, y: p.y }, progressed: s.tick });
  return sweep.target;
}

/** The region being swept is done with: swept on arrival, or set aside when it can't be reached. */
export function giveUpSweep(s: Game, p: Player): void {
  const sweep = sweeps.get(p);
  if (!sweep || sweep.region < 0) return;
  sweep.swept.set(sweep.region, s.tick);
  Object.assign(sweep, { region: -1, target: null });
}

/**
 * Whether `p` should get to `goal` by transit, and how: walk to station `from`, transit to `to`, the station
 * nearest the goal, and walk on. Taken when that is quicker than walking straight there, with straight-line walks
 * at full speed on both sides, and only when the cooldown will be spent by the time `p` reaches the station.
 */
export function transitPlan(s: Game, p: Player, goal: Vec2): { from: Station; to: Station } | null {
  const speed = movementSpeed(p, {}), ahead = s.map.stations.filter(st => st.x > s.hazardX + TILE);
  let best: { from: Station; to: Station } | null = null, cost = distance(p, goal) / speed;
  for (const from of ahead) {
    const reach = distance(p, from) / speed;
    if (p.railCd > reach) continue;
    for (const to of ahead) {
      if (to === from) continue;
      const via = reach + TRANSIT_OVERHEAD + transitTicks(s, from, to) + distance(to, goal) / speed;
      if (via < cost) { cost = via; best = { from, to }; }
    }
  }
  return best;
}
