import { lineClear, VISION } from '../movement.ts';
import { POTENTIAL_RADIUS, roofConceals } from '../view.ts';
import { distance } from './geometry.ts';
import { start, stop } from '../profiler.ts';
import { frameFields, ownPlayerFields, itemFields, gateFields, trapFields, projectileFields, effectFields, eventFields } from './projection-contract.ts';
import type { Game, Gate, GroundItem, Player, PlayerId, Projected, Snapshot, Vec2, World } from '../types.ts';
import { framedItems, groundItem, groundPosition, poseItems, publishItems } from './ground-items.ts';
import { publishGates, publishedGates } from './frame-gates.ts';
import { settledLayer } from '../frame-layers.ts';
import { heardBy } from './hearing.ts';
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
// Each published ground record's projection, made once and shared by every view and frame that carries the record.
// Published records are frozen and replaced when they change, so an unchanged item projects to the same object and
// its view layer matches its keyframe by identity (frame-layers.ts same()) instead of by value (#655).
const projectedItems = new WeakMap<GroundItem, Projected<GroundItem>>();
function projectedItem(item: GroundItem): Projected<GroundItem> {
  if (!Object.isFrozen(item)) return itemFields(item);
  let projected = projectedItems.get(item);
  if (!projected) projectedItems.set(item, projected = Object.freeze(itemFields(item)));
  return projected;
}
// Every view carries every gate, so a frame's gate list projects once for all of them. A published list never
// changes, and one projected list per published list lets each view's layer encoder match it by identity.
const projectedLists = new WeakMap<readonly Gate[], Projected<Gate>[]>(), projectedGateRecords = new WeakMap<Gate, Projected<Gate>>();
function projectedGates(gates: readonly Gate[]): Projected<Gate>[] {
  if (!publishedGates(gates)) return gates.map(gateFields);
  let list = projectedLists.get(gates);
  if (!list) {
    list = gates.map(gate => {
      let projected = projectedGateRecords.get(gate);
      if (!projected) projectedGateRecords.set(gate, projected = Object.freeze(gateFields(gate)));
      return projected;
    });
    projectedLists.set(gates, list); settledLayer(list);
  }
  return list;
}
export function playerView(s: Game, frame: Snapshot, id: PlayerId) {
  start('sim.playerView');
  try { return buildPlayerView(s, frame, id); } finally { stop('sim.playerView'); }
}
// A viewer id that matches no player is a non-player client: it receives the directed view, which is
// unfogged by design. Callers decide who is allowed to ask for one.
function buildPlayerView(s: Game, frame: Snapshot, id: PlayerId) {
  const viewer = frame.players.find(p => p.id === id);
  // Discovery stays out of snapshots, so live state is its only source.
  const live = s.players.find(p => p.id === id), discovery = live?.discovery;
  // Heard gunfire likewise; read at the frame's tick, which a player's own view is never behind.
  const heard = live ? heardBy(live, frame.tick) : [];
  // Effects are sized, so a wide ring counts as reachable when its edge is, not just its centre.
  const inRange = (p: Vec2 & { radius?: World | undefined }) => !viewer || distance(viewer, p) < POTENTIAL + (p.radius ?? 0);
  const rest = frameFields(frame); // Replay bookkeeping and unlisted internal fields stay private.
  const authorized = frame.players.filter(p => couldSee(s, viewer, p));
  // Items have no radius; the grid only spares testing those out of reach, and inRange still decides.
  const items = viewer ? framedItems(s, frame.items, viewer, POTENTIAL, inRange) : frame.items;
  return { ...rest, duration: s.content.durationTicks, directed: !viewer, contestantsActive: frame.players.filter(p => p.role === 'contestant' && p.status === 'active').length,
    ...(frame.bodies ? projectPhysicsPresentation(frame, viewer, new Set(authorized.map(p => p.id)), items, inRange) : {}),
    ...(frame.bodies && viewer ? { predictionMotor: {
      acceleration: s.content.actorPhysics?.acceleration ?? DEFAULT_CHARACTER_MOTOR.acceleration,
      braking: s.content.actorPhysics?.braking ?? DEFAULT_CHARACTER_MOTOR.braking,
      maxSpeed: s.content.actorPhysics?.maxSpeed ?? MAX_PHYSICS_SPEED,
    }, predictionTethered: (frame.physics?.world.constraints ?? []).some(c => c.a === `actor:${viewer.id}` || c.b === `actor:${viewer.id}`),
    // The viewer's own flight, pending hit or pull, which hidden endpoints may omit from tethers and flights.
    ...(frame.physics?.hooks ? { hookActive: frame.physics.hooks.some(hook => hook.caster === viewer.id) } : {}) } : {}),
    players: authorized.map(p => p.id === id ? ownPlayerFields(p, discovery, heard) : observed(p)),
    items: items.map(projectedItem), gates: frame.gates && projectedGates(frame.gates),
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
    const ground = publishItems(s);
    const presentation = physics ? capturePhysicsPresentation(physics, s.players, id => groundItem(s, id)?.id) : undefined;
    // A physical item's stored/projection pose changes the item layer too, even before its gameplay
    // owner synchronizes the map record. Never change that gameplay record while taking a snapshot:
    // a differing pose gives the frame its own list.
    const poses = new Map<number, GroundItem>();
    for (const body of presentation?.bodies ?? []) {
      const at = body.itemId === undefined ? undefined : groundPosition(s, String(body.itemId)), item = at === undefined ? undefined : ground[at];
      if (!item || Object.is(item.x, body.x) && Object.is(item.y, body.y)) continue;
      poses.set(at!, Object.freeze({ ...item, x: body.x, y: body.y }));
    }
    const items = poses.size ? poseItems(ground, poses) : ground;
    stop('sim.snapshot.presentation');
    start('sim.snapshot.clone');
    // The ground and gate lists are shared, not cloned: their records are frozen and replaced when they change.
    // The physics state and its presentation are already the frame's own, apart from frozen shared records.
    const frame: Snapshot = structuredClone({ version: s.version, duration: s.content.durationTicks, cellChargeTicks: s.content.cellChargeTicks, tick: s.tick, phase: s.phase, rng: s.rng, hazardX: s.hazardX, slots: s.slots, serial: s.serial, players: s.players, items: null, gates: null, traps: s.map.traps, projectiles: s.projectiles, effects: s.effects, events: s.events, ...(s.itemSerial !== undefined ? { itemSerial: s.itemSerial } : {}) }) as unknown as Snapshot;
    frame.items = items as GroundItem[];
    frame.gates = s.map.gates && publishGates(s) as Gate[];
    return physics ? Object.assign(frame, { physics }, presentation) : frame;
  }
  finally { stop('sim.snapshot.clone'); stop('sim.snapshot'); }
}
