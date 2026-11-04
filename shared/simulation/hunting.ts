import { movementSpeed, TILE } from '../movement.ts';
import { portalGraphOf } from '../navigation/portal-graph.ts';
import { distance } from './geometry.ts';
import { heardBy } from './hearing.ts';
import { HZ, INITIAL_ESCAPE_SLOTS } from './rules.ts';
import { transitTicks } from './transit.ts';
import { visibleTo } from './visibility.ts';
import type { Game, Player, Station, Tick, Vec2, World } from '../types.ts';

// How a gladiator bot hunts with nothing seen (#683, #681, 14 "Gladiator bots"): it sweeps regions ahead of the wall,
// and it takes transit when the trip to its goal is shorter that way. Under `hunting: 'front'` (`content-12`) it
// estimates contestant progress from left to right in the vertical middle until evidence places a contestant further
// right, picks coarse sweep legs so transit pays off, repels other targetless gladiators, and heads toward the exit to
// goalkeep once evidence suggests a contestant is further right. Bot-private, never projected or recorded.

/** Time a transit costs beyond its travel time: lining up on the station and landing. */
const TRANSIT_OVERHEAD = 3 * HZ;
/** Sweeping looks only at regions whose centre is at least this far ahead of the wall. */
const SWEEP_AHEAD: World = 600;
/** Each unit a region lies ahead of the wall counts this much against it (`content-11`). */
const SWEEP_WALLWARD = 0.5;
/**
 * A region counts as swept on coming within this of its target, or after SWEEP_STALL without moving a tile: a trip
 * by transit walks away from the target first, so getting closer is not the test.
 */
const SWEEP_ARRIVE: World = 400, SWEEP_STALL = 10 * HZ;
/** A swept region is not swept again for this long. */
const SWEEP_REVISIT = 90 * HZ;
/** Under `hunting: 'front'`, a sweep step prefers regions at least this far from where the gladiator stands. */
const FRONT_MIN_STEP: World = 2400;
/** Estimated left-to-right contestant advance speed (world units per tick) and how far ahead of the wall the front stays. */
const FRONT_SPEED = 4.0, FRONT_WALL_LEAD: World = 6000;
/** How strongly `hunting: 'front'` pulls candidate regions toward the estimated horizontal front and vertical middle. */
const FRONT_X_WEIGHT = 2.0, FRONT_Y_WEIGHT = 1.0, FRONT_DISTANCE_WEIGHT = 0.08;
/** Range within which targetless gladiators repel each other's positions and sweep targets, and peak penalty. */
const FRONT_REPEL_RANGE: World = 3600, FRONT_REPEL_WEIGHT: World = 2400;
/** Margin ahead of the estimated front that counts as evidence a contestant is further right. */
const FRONT_EVIDENCE_MARGIN: World = 1600;
/** Radius around the exit within which goalkeeping gladiators patrol when repelling each other. */
const GOALKEEP_RADIUS: World = 2400;

interface Sweep {
  /** The tick each region was last swept. */
  swept: Map<number, Tick>;
  region: number;
  target: Vec2 | null;
  /** Whether this gladiator currently has a concrete target (sight or gunfire lead). */
  targeted?: boolean;
  /** Where the gladiator last stood a tile away from, and when. */
  moved: Vec2;
  progressed: Tick;
}
const sweeps = new WeakMap<Player, Sweep>();
const frontEvidence = new WeakMap<Game, { tick: Tick; furtherRight: boolean }>();

/** Estimated left-to-right contestant x from elapsed match time, clamped ahead of the wall. */
export function estimatedFrontX(s: Game): World {
  const startX = s.map.entry?.x ?? 0, endX = s.map.exit.x;
  const elapsedX = startX + s.tick * FRONT_SPEED;
  const wallLead = Math.min(FRONT_WALL_LEAD, (endX - startX) * 0.45);
  const raw = Math.max(elapsedX, s.hazardX + wallLead);
  return Math.min(endX, Math.max(s.hazardX + SWEEP_AHEAD, raw));
}

/**
 * Update and return whether gladiators have evidence that at least one contestant is further right than the
 * estimated front (or at the exit): a sighted or revealed contestant further right, a heard gunfire cue further right,
 * a charged power cell or claimed escape pod, or the estimated front itself reaching the exit.
 */
export function hasEvidenceFurtherRight(s: Game): boolean {
  let state = frontEvidence.get(s);
  if (!state) frontEvidence.set(s, state = { tick: -1 as Tick, furtherRight: false });
  if (state.furtherRight || state.tick === s.tick) return state.furtherRight;
  state.tick = s.tick;
  const frontX = estimatedFrontX(s);
  const threshold = Math.min(s.map.exit.x - SWEEP_ARRIVE, frontX + FRONT_EVIDENCE_MARGIN);
  if (frontX >= s.map.exit.x - SWEEP_ARRIVE || s.slots < INITIAL_ESCAPE_SLOTS
    || s.events.some(e => e.text.includes('charged a power cell') || e.text.includes('powered an escape pod'))) {
    state.furtherRight = true;
    return true;
  }
  const gladiators = s.players.filter(p => p.role === 'gladiator' && p.status === 'active');
  for (const g of gladiators) {
    if (heardBy(g, s.tick).some(cue => cue.x > threshold)) { state.furtherRight = true; return true; }
  }
  for (const c of s.players) {
    if (c.role !== 'contestant' || c.status !== 'active' || c.x <= threshold) continue;
    if (c.revealed > 0 || gladiators.some(g => visibleTo(s, g, c))) { state.furtherRight = true; return true; }
  }
  return false;
}

/** Record whether `p` currently has a concrete target (a seen contestant or a gunfire lead). */
export function noteHunterTarget(s: Game, p: Player, targeted: boolean): void {
  let sweep = sweeps.get(p);
  if (!sweep) sweeps.set(p, sweep = { swept: new Map(), region: -1, target: null, moved: { x: p.x, y: p.y }, progressed: s.tick });
  sweep.targeted = targeted;
  if (s.content.hunting === 'front') hasEvidenceFurtherRight(s);
}

function repulsionPenalty(p: Player, peers: Player[], centre: Vec2): number {
  let penalty = 0;
  for (const q of peers) {
    const posDist = distance(q, centre);
    if (posDist < FRONT_REPEL_RANGE) penalty += (1 - posDist / FRONT_REPEL_RANGE) * FRONT_REPEL_WEIGHT;
    const peerTarget = sweeps.get(q)?.target;
    if (peerTarget) {
      const targetDist = distance(peerTarget, centre);
      if (targetDist < FRONT_REPEL_RANGE) penalty += (1 - targetDist / FRONT_REPEL_RANGE) * FRONT_REPEL_WEIGHT;
    }
  }
  return penalty;
}

/**
 * Where `p` sweeps next: under `hunting: 'sweep'`, a standable spot in the region ahead of the wall and not swept
 * lately that is nearest once each unit ahead of the wall is weighed in, leaving out regions the other gladiators are
 * sweeping. Under `hunting: 'front'`, coarse regions around the estimated front in the vertical middle while repelling
 * other targetless gladiators, or goalkeeping near the exit once evidence places a contestant further right.
 */
export function sweepTarget(s: Game, p: Player, stand: (centre: Vec2) => Vec2): Vec2 | null {
  const frontMode = s.content.hunting === 'front';
  const goalkeep = frontMode && hasEvidenceFurtherRight(s);
  const graph = portalGraphOf(s.map);
  if (!graph) return goalkeep ? stand(s.map.exit) : null;
  let sweep = sweeps.get(p);
  if (!sweep) sweeps.set(p, sweep = { swept: new Map(), region: -1, target: null, moved: { x: p.x, y: p.y }, progressed: s.tick });
  if (sweep.target) {
    if (distance(p, sweep.moved) > TILE) { sweep.moved = { x: p.x, y: p.y }; sweep.progressed = s.tick; }
    if (distance(p, sweep.target) < SWEEP_ARRIVE || s.tick - sweep.progressed > SWEEP_STALL) giveUpSweep(s, p);
    else return sweep.target;
  }
  const peers = s.players.filter(q => q !== p && q.role === 'gladiator' && q.status !== 'eliminated' && (!frontMode || !sweeps.get(q)?.targeted));
  const taken = new Set(peers.map(q => sweeps.get(q)?.region));
  if (!frontMode) {
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
  const anchor: Vec2 = goalkeep ? s.map.exit : { x: estimatedFrontX(s), y: s.map.height / 2 };
  const minStep = goalkeep ? 0 : FRONT_MIN_STEP;
  const pickRegion = (requireDistant: boolean, ignoreRevisit: boolean): number => {
    let best = -1, score = Infinity;
    graph.regions.forEach((region, index) => {
      const centre = { x: region.box.x + region.box.w / 2, y: region.box.y + region.box.h / 2 };
      if (centre.x < s.hazardX + SWEEP_AHEAD || taken.has(index)) return;
      if (!ignoreRevisit && s.tick - (sweep!.swept.get(index) ?? -Infinity) < SWEEP_REVISIT) return;
      const d = distance(p, centre);
      if (requireDistant && d < minStep) return;
      if (goalkeep && distance(anchor, centre) > GOALKEEP_RADIUS && requireDistant) return;
      const value = Math.abs(centre.x - anchor.x) * FRONT_X_WEIGHT + Math.abs(centre.y - anchor.y) * FRONT_Y_WEIGHT
        + d * FRONT_DISTANCE_WEIGHT + repulsionPenalty(p, peers, centre);
      if (value < score) { score = value; best = index; }
    });
    return best;
  };
  let best = pickRegion(true, false);
  if (best < 0) best = pickRegion(false, false);
  if (best < 0) best = pickRegion(false, true);
  if (best < 0) return goalkeep ? stand(s.map.exit) : null;
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
