import { lineClear, VISION } from '../movement.ts';
import { POTENTIAL_RADIUS, roofConceals } from '../view.ts';
import { distance } from './geometry.ts';
import { start, stop } from '../profiler.ts';
import { frameFields, ownPlayerFields, itemFields, gateFields, trapFields, projectileFields, effectFields, eventFields } from './projection-contract.ts';
import type { Game, Player, PlayerId, Snapshot, Vec2, World } from '../types.ts';
import { physicsState } from './physics-runtime.ts';
import { DEFAULT_CHARACTER_MOTOR } from './actor-physics.ts';
import { MAX_PHYSICS_SPEED } from '../physics/motion-limits.ts';
import { capturePhysicsPresentation, projectPhysicsPresentation } from './physics-presentation.ts';
// The reach the server transmits within. Generous on purpose: it carries everything that could become
// visible before the next update — through cover clearing, a cloak dropping, a scan reveal, or simply
// movement — so the client never has to wait on the server to show something that just became
// observable. The client resolves what is actually seen. The trade is explicit: this radius is also
// what a modified client could see through walls.
export const POTENTIAL = POTENTIAL_RADIUS;
// What the server will send, as opposed to what the viewer can actually see.
// `s` is unread: this deliberately mirrors `visibleTo` below so the two are interchangeable at a
// call site, and a distance cull must not start depending on wider state. Kept, not an oversight.
export function couldSee(s: Game, viewer: Player | null | undefined, target: Player): boolean {
  if (!viewer || viewer.id === target.id || target.status !== 'active') return true;
  // A reveal makes a contestant visible to gladiators at any range, so it is never distance culled.
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return distance(viewer, target) < POTENTIAL;
}
// True line of sight. This stays authoritative and drives gameplay — bot targeting, ability reach,
// hit resolution — none of which may depend on anything a client says.
export function visibleTo(s: Game, viewer: Player | null | undefined, target: Player): boolean {
  if (!viewer || viewer.id === target.id || target.status !== 'active') return true;
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return !target.cloak && visiblePoint(s, viewer, target);
}
/** Geometric sight for a point without actor status, cloak, or reveal rules. */
export function visiblePoint(s: Game, viewer: Vec2, target: Vec2): boolean {
  return !roofConceals(s.map, viewer, target) && distance(viewer, target) < VISION && lineClear(s.map, viewer, target);
}
// What one client may learn about another player it can currently see. Everything omitted is either
// private (inventory, ability timers, whether a slot is a bot) or unread by the renderer, so it never
// leaves the server for anyone but the player it describes. Recordings keep the full state.
const OBSERVED = ['id', 'role', 'kit', 'name', 'x', 'y', 'heading', 'status', 'hp', 'maxHp', 'shield', 'weapon', 'cloak', 'revealed'];
export const observed = (p: Player) => Object.fromEntries(OBSERVED.map(key => [key, p[key as keyof Player]]));
export function playerView(s: Game, frame: Snapshot, id: PlayerId) {
  start('sim.playerView');
  try { return buildPlayerView(s, frame, id); } finally { stop('sim.playerView'); }
}
// A viewer id that matches no player is a non-player client: it receives the directed view, which is
// unfogged by design. Callers decide who is allowed to ask for one.
function buildPlayerView(s: Game, frame: Snapshot, id: PlayerId) {
  const viewer = frame.players.find(p => p.id === id);
  // Discovery stays out of snapshots, so live state is its only source.
  const discovery = s.players.find(p => p.id === id)?.discovery;
  // Effects are sized, so a wide ring counts as reachable when its edge is, not just its centre.
  const inRange = (p: Vec2 & { radius?: World | undefined }) => !viewer || distance(viewer, p) < POTENTIAL + (p.radius ?? 0);
  const rest = frameFields(frame); // Replay bookkeeping and unlisted internal fields stay private.
  const authorized = frame.players.filter(p => couldSee(s, viewer, p));
  return { ...rest, duration: s.content.durationTicks, directed: !viewer, contestantsActive: frame.players.filter(p => p.role === 'contestant' && p.status === 'active').length,
    ...(frame.bodies ? projectPhysicsPresentation(frame, viewer, new Set(authorized.map(p => p.id)), inRange) : {}),
    ...(frame.bodies && viewer ? { predictionMotor: {
      acceleration: s.content.actorPhysics?.acceleration ?? DEFAULT_CHARACTER_MOTOR.acceleration,
      braking: s.content.actorPhysics?.braking ?? DEFAULT_CHARACTER_MOTOR.braking,
      maxSpeed: s.content.actorPhysics?.maxSpeed ?? MAX_PHYSICS_SPEED,
    }, predictionTethered: (frame.physics?.world.constraints ?? []).some(c => c.a === `actor:${viewer.id}` || c.b === `actor:${viewer.id}`),
    // The viewer's own flight, pending hit or pull, which hidden endpoints may omit from tethers and flights.
    ...(frame.physics?.hooks ? { hookActive: frame.physics.hooks.some(hook => hook.caster === viewer.id) } : {}) } : {}),
    players: authorized.map(p => p.id === id ? ownPlayerFields(p, discovery) : observed(p)),
    items: frame.items.filter(inRange).map(itemFields), gates: frame.gates?.map(gateFields),
    traps: (frame.traps || []).filter(inRange).map(trapFields), projectiles: frame.projectiles.filter(inRange).map(projectileFields),
    effects: frame.effects.filter(inRange).map(effectFields), events: frame.events?.map(eventFields) };
}
export function snapshot(s: Game): Snapshot {
  // Inclusive; its parts are timed separately: the physics world copy, the presentation capture and the clone.
  start('sim.snapshot');
  try {
    start('sim.snapshot.world');
    const physics = physicsState(s);
    stop('sim.snapshot.world');
    start('sim.snapshot.presentation');
    const presentation = physics ? capturePhysicsPresentation(physics, { players: s.players, items: s.map.items }) : undefined;
    const itemBodies = new Map(presentation?.bodies.filter(b => b.itemId !== undefined).map(b => [b.itemId, b]));
    // A physical item's stored/projection pose changes the item layer too, even before its gameplay
    // owner synchronizes the map record. Never mutate that gameplay record while taking a snapshot.
    const items = itemBodies.size ? s.map.items.map(item => {
      const body = itemBodies.get(item.id);
      return body ? { ...item, x: body.x, y: body.y } : item;
    }) : s.map.items;
    stop('sim.snapshot.presentation');
    start('sim.snapshot.clone');
    return structuredClone({ version: s.version, duration: s.content.durationTicks, cellChargeTicks: s.content.cellChargeTicks, tick: s.tick, phase: s.phase, rng: s.rng, hazardX: s.hazardX, slots: s.slots, serial: s.serial, players: s.players, items, gates: s.map.gates, traps: s.map.traps, projectiles: s.projectiles, effects: s.effects, events: s.events, ...(s.itemSerial !== undefined ? { itemSerial: s.itemSerial } : {}), ...(physics ? { physics, ...presentation } : {}) });
  }
  finally { stop('sim.snapshot.clone'); stop('sim.snapshot'); }
}
