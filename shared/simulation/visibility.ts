import { bodyRelations, hydrateFrame, compactItems, omitBodyPose as omitPose } from '../relational-frame.ts';
import { playerSlot } from './relations.ts';
import { lineClear, VISION } from '../movement.ts';
import { POTENTIAL_RADIUS, roofConceals } from '../view.ts';
import { distance } from './geometry.ts';
import { start, stop } from '../profiler.ts';
import { frameFields, ownPlayerFields, itemFields, trapFields, projectileFields, effectFields, eventFields } from './projection-contract.ts';
import type { Game, Gate, GateState, GateIdx, GroundItem, ItemKey, Player, PlayerId, PlayerIdx, Projected, Snapshot, Vec2, World } from '../types.ts';
import { publishItems, framedItems, shareItemPublication } from './ground-items.ts';
import { publishGates, publishedGates, shareGatePublication } from './frame-gates.ts';
import { settledLayer } from '../frame-layers.ts';
import { heardBy } from './hearing.ts';
import { capturePhysicsPresentation, projectPhysicsPresentation } from './physics-presentation.ts';
import { assertWireDomain, wireCache, wireIds, type WireIds } from './wire-ids.ts';
// The reach the server transmits within. Generous on purpose: it carries everything that could become
// visible before the next update — through cover clearing, a cloak dropping, a scan reveal, or simply
// movement — so the client never has to wait on the server to show something that just became
// observable. The client resolves what is actually seen. The trade is explicit: this radius is also
// what a modified client could see through walls.
export const POTENTIAL = POTENTIAL_RADIUS;
// What the server will send, as opposed to what the viewer can actually see.
// `s` is unread: this deliberately mirrors `visibleTo` below so the two are interchangeable at a
// call site, and a distance cull must not start depending on wider state. Kept, not an oversight.
export function couldSee(s: Game, viewer: Player<ItemKey> | null | undefined, target: Player<ItemKey>): boolean {
  if (!viewer || viewer.id === target.id || target.status !== 'active') return true;
  // A reveal makes a contestant visible to gladiators at any range, so it is never distance culled.
  if (viewer.role === 'gladiator' && target.revealed > 0) return true;
  return distance(viewer, target) < POTENTIAL;
}
// True line of sight. This stays authoritative and drives gameplay — bot targeting, ability reach,
// hit resolution — none of which may depend on anything a client says.
export function visibleTo(s: Game, viewer: Player<ItemKey> | null | undefined, target: Player<ItemKey>): boolean {
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
export const OBSERVED = ['heading', 'status', 'hp', 'maxHp', 'shield', 'weapon', 'cloak', 'revealed'];
// `posed` false leaves out the pose an actor's body already carries (24.4), rather than copying it out again.
export const observed = (p: Player<ItemKey>, playerIdx?: PlayerIdx, posed = true) => ({
  ...(playerIdx !== undefined ? { playerIdx } : {}),
  ...Object.fromEntries(OBSERVED.map(key => [key, p[key as keyof Player]])), ...(posed ? { x: p.x, y: p.y } : {}),
});
// Cached per source record and per mapping (#1164), so keyed IDs are mapped once per record, not per view.
const itemCache = (wire: WireIds) => wireCache<GroundItem, Projected<GroundItem>>(wire, 'projectedItem');
function projectedItem(item: GroundItem, wire: WireIds, projectedItems: WeakMap<GroundItem, Projected<GroundItem>>): Projected<GroundItem> {
  let projected = projectedItems.get(item);
  if (!projected) { projected = itemFields(item, wire); if (Object.isFrozen(item)) projectedItems.set(item, projected = Object.freeze(projected)); }
  return projected;
}
const gateLists = new WeakMap<readonly Gate[], GateState[]>(), gateRecords = new WeakMap<Gate, GateState>();
export function dynamicGates(gates: readonly Gate[]): GateState[] {
  let list = gateLists.get(gates);
  if (!list) {
    list = gates.map((gate, i) => {
      let record = gateRecords.get(gate);
      if (!record || record.gateIdx !== i) { record = Object.freeze({ gateIdx: i as GateIdx, open: gate.open, locked: gate.locked }); if (Object.isFrozen(gate)) gateRecords.set(gate, record); }
      return record;
    });
    if (publishedGates(gates)) { gateLists.set(gates, list); settledLayer(list); shareGatePublication(list); }
  }
  return list;
}
/** `wire` is the match's outward ID mapping (#1164); the identity unless the server keyed the match. */
export function playerView(s: Game, frame: Snapshot, id: PlayerId | null | undefined, wire: WireIds = wireIds()) {
  start('sim.playerView');
  try { return buildPlayerView(s, frame, id, wire); } finally { stop('sim.playerView'); }
}
// A viewer id that matches no player is a non-player client: it receives the directed view, which is
// unfogged by design. Callers decide who is allowed to ask for one.
function buildPlayerView(s: Game, frame: Snapshot, id: PlayerId | null | undefined, wire: WireIds) {
  assertWireDomain(frame);
  // Directed clients have no player association, so skip both live and captured roster lookup.
  const liveIdx = id == null ? undefined : playerSlot(s, id);
  // A historical seat move or an unknown label needs only a short scan of this captured roster.
  // Fresh spectator frames must never allocate a label table just to establish a miss.
  const hydrated = hydrateFrame(frame);
  const players = hydrated.players as Array<Player & { playerIdx: PlayerIdx }>;
  const relations = bodyRelations(frame.bodies);
  const viewer = id == null ? undefined : liveIdx !== undefined && players[liveIdx]?.id === id
    ? players[liveIdx] : players.find(p => p.id === id);
  // Discovery stays out of snapshots, so live state is its only source.
  const live = liveIdx === undefined ? undefined : s.players[liveIdx], discovery = live?.discovery;
  // Heard gunfire likewise; read at the frame's tick, which a player's own view is never behind.
  const heard = live ? heardBy(live, frame.tick) : [];
  // Effects are sized, so a wide ring counts as reachable when its edge is, not just its centre.
  const inRange = (p: Vec2 & { radius?: World | undefined }) => !viewer || distance(viewer, p) < POTENTIAL + (p.radius ?? 0);
  const rest = frameFields(frame); // Replay bookkeeping and unlisted internal fields stay private.
  const authorized = players.filter(p => couldSee(s, viewer, p));
  // Items have no radius; the grid only spares testing those out of reach, and inRange still decides.
  const itemBodies = relations.items;
  const ground = hydrated.items as GroundItem[];
  shareItemPublication(frame.items, ground);
  const items = viewer ? framedItems(s, ground, viewer, POTENTIAL, inRange) : ground;
  const projectedItems = itemCache(wire);
  const projectPlayer = (p: Player & { playerIdx: PlayerIdx }, own = false) => {
    const posed = !relations.byActor(p.playerIdx);
    return own ? ownPlayerFields(p, discovery, heard, p.playerIdx, wire, posed) : observed(p, p.playerIdx, posed);
  };
  return { ...rest, duration: s.content.durationTicks, directed: !viewer, contestantsActive: frame.players.filter(p => p.role === 'contestant' && p.status === 'active').length,
    ...(frame.bodies ? projectPhysicsPresentation(frame, viewer, new Set(authorized.map(p => p.playerIdx)), items, inRange, wire) : {}),
    ...(frame.bodies && viewer ? { predictionMotor: {
      acceleration: s.content.actorPhysics.acceleration,
      braking: s.content.actorPhysics.braking,
      maxSpeed: s.content.actorPhysics.maxSpeed,
      surfaces: true,
    }, predictionTethered: (frame.physics?.world.constraints ?? []).some(c => c.a === `actor:${viewer.id}` || c.b === `actor:${viewer.id}`),
    // The viewer's own flight, pending hit or pull, which hidden endpoints may omit from tethers and flights.
    ...(frame.physics?.hooks ? { hookActive: frame.physics.hooks.some(hook => hook.caster === viewer.id) } : {}) } : {}),
    ...(viewer ? { self: projectPlayer(viewer, true) } : {}),
    players: authorized.filter(p => p !== viewer).map(p => projectPlayer(p)),
    items: items.map(item => { const projected = projectedItem(item, wire, projectedItems); return itemBodies.has(item.id) ? omitPose(projected) : projected; }), gates: frame.gates,
    traps: (frame.traps || []).filter(inRange).map(trap => trapFields(trap)), projectiles: frame.projectiles.filter(inRange).map(shot => projectileFields(shot, wire)),
    effects: frame.effects.filter(inRange).map(effect => effectFields(effect, wire)), events: frame.events?.map(event => eventFields(event, wire)) };
}
export function snapshot(s: Game): Snapshot {
  // Inclusive; presentation timing accumulates numeric capture and physical item pose publication.
  start('sim.snapshot');
  try {
    const captured = capturePhysicsPresentation(s), physics = captured?.physics;
    start('sim.snapshot.presentation');
    const ground = publishItems(s);
    const presentation = captured ? { physicsProfile: captured.physicsProfile, bodies: captured.bodies, tethers: captured.tethers, ...(captured.hookFlights ? { hookFlights: captured.hookFlights } : {}) } : undefined;
    stop('sim.snapshot.presentation');
    start('sim.snapshot.clone');
    // The ground and gate lists are shared, not cloned: their records are frozen and replaced when they change.
    // The physics state and its presentation are already the frame's own, apart from frozen shared records.
    const frame: Snapshot = structuredClone({ version: s.version, duration: s.content.durationTicks, cellChargeTicks: s.content.cellChargeTicks, tick: s.tick, phase: s.phase, rng: s.rng, hazardX: s.hazardX, slots: s.slots, serial: s.serial, players: s.players, items: null, gates: null, traps: s.map.traps, projectiles: s.projectiles, effects: s.effects, events: s.events, ...(s.itemSerial !== undefined ? { itemSerial: s.itemSerial, scatterSerial: s.scatterSerial } : {}) }) as unknown as Snapshot;
    frame.items = compactItems(ground, captured?.bodies);
    shareItemPublication(ground, frame.items);
    const actors = bodyRelations(captured?.bodies);
    frame.players = frame.players.map((p, i) => { const player = { ...p, playerIdx: i as PlayerIdx }; return actors.byActor(i as PlayerIdx) ? omitPose(player) : player; });
    frame.gates = dynamicGates(publishGates(s));
    return physics ? Object.assign(frame, { physics }, presentation) : frame;
  }
  finally { stop('sim.snapshot.clone'); stop('sim.snapshot'); }
}
