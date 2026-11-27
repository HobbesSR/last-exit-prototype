import { bodyRelations, hydrateFrame, compactItems, omitBodyPose as omitPose } from '../relational-frame.ts';
import { heardBy } from './hearing.ts';
import { playerSlot } from './relations.ts';
import { lineClear, VISION } from '../sight.ts';
import { POTENTIAL_RADIUS, roofConceals } from '../view.ts';
import { distance } from './geometry.ts';
import { start, stop } from '../profiler.ts';
import { OBSERVED, frameFields, ownPlayerFields, itemFields, trapFields, projectileFields, effectFields, eventFields } from './projection-contract.ts';
import type { Effect, Game, Gate, GateState, GateIdx, GroundItem, HeardCue, ItemKey, Player, PlayerId, PlayerIdx, Projectile, Projected, Snapshot, Tick, Trap, Vec2, World } from '../types.ts';
import { publishItems, framedItems, shareItemPublication } from './ground-items.ts';
import { publishGates, publishedGates, shareGatePublication } from './frame-gates.ts';
import { settledLayer } from '../frame-layers.ts';
import { authorizePresentation, capturePhysicsPresentation, presentationFields, type AuthorizedPresentation, type PhysicsPresentation } from './physics-presentation.ts';
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
export function couldSee(viewer: Player<ItemKey> | null | undefined, target: Player<ItemKey>): boolean {
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
export { OBSERVED };
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
function dynamicGates(gates: readonly Gate[]): GateState[] {
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
/** A viewer's knowledge that frames do not carry, by roster place: the core's for a started game (`TickProjection`). */
export interface ViewKnowledge {
  /** The discovery cells a contestant has discovered, in the order learned, or null when it keeps no memory. */
  discovered(slot: PlayerIdx): Iterable<number> | null;
  /** The cues a player hears that last past `tick`. */
  heard(slot: PlayerIdx, tick: Tick): readonly HeardCue[];
}
/** What the rules' projection reads besides the frame: the seat a player ID holds, its knowledge, and the ground. */
export interface ViewSource {
  /** The roster place a player ID holds now, or undefined for a non-player viewer. */
  slotOf(id: PlayerId): PlayerIdx | undefined;
  knowledge: ViewKnowledge;
  /** The ground list `framedItems` may use the item grid of, besides a frame store's: the unstarted game's own. */
  ground?: readonly GroundItem[] | undefined;
}
const sources = new WeakMap<Game, ViewSource>();
/** A started game's session registers its rules' source: its seats and the core's knowledge (`createTickSession`). */
export function registerViewSource(s: Game, source: ViewSource): void { sources.set(s, source); }
/**
 * The rules' source for a game a test or tool holds: its session's once started (the seats through `MatchIds`, knowledge
 * from the core), else its players as arranged.
 */
export function viewSourceOf(s: Game): ViewSource {
  return sources.get(s) ?? {
    slotOf: id => playerSlot(s, id),
    knowledge: {
      discovered: slot => s.players[slot]?.discovery?.discovered ?? null,
      heard: (slot, tick) => { const p = s.players[slot]; return p ? heardBy(p, tick) : []; },
    },
    ground: s.items,
  };
}
/**
 * One viewer's view of a frame by the TypeScript rules, from the frame and `source` alone (docs/27.2 "Projection and
 * knowledge"). `wire` is the match's outward ID mapping (#1164); the identity unless the server keyed the match.
 */
export function projectView(source: ViewSource, frame: Snapshot, id: PlayerId | null | undefined, wire: WireIds = wireIds()) {
  start('sim.playerView');
  try { return buildPlayerView(source, frame, id, wire); } finally { stop('sim.playerView'); }
}
/**
 * A view of a snapshot a test or tool holds, by the TypeScript rules (`viewSourceOf`): a started game's with the core's
 * knowledge. The snapshot is the caller's to edit, so the core never decides it (review 1135); the view the core decides of
 * the store's current frame, as a room projects it, is `currentView` (`tick.ts`).
 */
export function playerView(s: Game, frame: Snapshot, id: PlayerId | null | undefined, wire: WireIds = wireIds()) {
  return projectView(viewSourceOf(s), frame, id, wire);
}
/** A frame player with its roster place, as `hydrateFrame` gives it. */
export type FramePlayer = Player & { playerIdx: PlayerIdx };

/**
 * What one viewer may receive of a frame: the information rule's answer (15, 24 "Potential visibility"). Every list holds
 * the frame's own records in the frame's order. The TypeScript rules decide it (`decideByRules`), and for a live player
 * view the core does (`tick-projection.ts`, #1357); `assembleView` builds the same view from either.
 */
export interface ViewDecision extends AuthorizedPresentation {
  /** The players the viewer may receive, itself included. */
  players: readonly FramePlayer[];
  items: readonly GroundItem[];
  traps: readonly Trap[];
  projectiles: readonly Projectile[];
  effects: readonly Effect[];
  /** The viewer's discovered cells in the order learned, or null when it keeps none. */
  discovered: Iterable<number> | null;
  /** The cues the viewer hears at the frame's tick. */
  heard: readonly HeardCue[];
}

/** A frame as projection reads it: hydrated, with its body relations and its ground published. */
export function readFrame(frame: Snapshot) {
  assertWireDomain(frame);
  const hydrated = hydrateFrame(frame);
  const ground = hydrated.items as GroundItem[];
  shareItemPublication(frame.items, ground);
  return { frame, players: hydrated.players as FramePlayer[], ground, relations: bodyRelations(frame.bodies) };
}
export type ReadFrame = ReturnType<typeof readFrame>;

/** The viewer a projection is for: its live roster place, else the captured roster's player with that ID (#792). */
export function viewerOf(read: ReadFrame, id: PlayerId | null | undefined, liveIdx: PlayerIdx | undefined): FramePlayer | undefined {
  // A historical seat move or an unknown label needs only a short scan of this captured roster.
  // Fresh spectator frames must never allocate a label table just to establish a miss.
  return id == null ? undefined : liveIdx !== undefined && read.players[liveIdx]?.id === id ? read.players[liveIdx] : read.players.find(p => p.id === id);
}

/** The TypeScript information rule: everything for a directed view, else what lies within the potential radius. */
function decideByRules(source: ViewSource, read: ReadFrame, viewer: FramePlayer | undefined, liveIdx: PlayerIdx | undefined): ViewDecision {
  const { frame, players, ground } = read;
  // Effects are sized, so a wide ring counts as reachable when its edge is, not just its centre.
  const inRange = (p: Vec2 & { radius?: World | undefined }) => !viewer || distance(viewer, p) < POTENTIAL + (p.radius ?? 0);
  const authorized = players.filter(p => couldSee(viewer, p));
  // Items have no radius; the grid only spares testing those out of reach, and inRange still decides.
  const items = viewer ? framedItems(source.ground, ground, viewer, POTENTIAL, inRange) : ground;
  return {
    players: authorized, items,
    ...(frame.bodies ? authorizePresentation(frame, viewer, new Set(authorized.map(p => p.playerIdx)), items, inRange) : { bodies: [], tethers: [], hookFlights: undefined }),
    traps: (frame.traps || []).filter(inRange), projectiles: frame.projectiles.filter(inRange), effects: frame.effects.filter(inRange),
    // Discovery stays out of snapshots, so the knowledge cache is its only source; heard gunfire likewise, read at the
    // frame's tick, which a player's own view is never behind.
    discovered: liveIdx === undefined ? null : source.knowledge.discovered(liveIdx),
    heard: liveIdx === undefined ? [] : source.knowledge.heard(liveIdx, frame.tick),
  };
}

// A viewer id that matches no player is a non-player client: it receives the directed view, which is
// unfogged by design. Callers decide who is allowed to ask for one.
function buildPlayerView(source: ViewSource, frame: Snapshot, id: PlayerId | null | undefined, wire: WireIds) {
  const read = readFrame(frame);
  // Directed clients have no player association, so skip both live and captured roster lookup.
  const liveIdx = id == null ? undefined : source.slotOf(id);
  const viewer = viewerOf(read, id, liveIdx);
  return assembleView(read, viewer, decideByRules(source, read, viewer, liveIdx), wire);
}

/** One viewer's view of a frame from a decision of what it may receive: the closed field contracts, keyed by `wire`. */
export function assembleView(read: ReadFrame, viewer: FramePlayer | undefined, d: ViewDecision, wire: WireIds) {
  const { frame, relations } = read;
  const rest = frameFields(frame); // Replay bookkeeping and unlisted internal fields stay private.
  const itemBodies = relations.items;
  const projectedItems = itemCache(wire);
  const discovered = d.discovered;
  const projectPlayer = (p: FramePlayer, own = false) => {
    const posed = !relations.byActor(p.playerIdx);
    return own ? ownPlayerFields(p, discovered && { discovered }, d.heard, p.playerIdx, wire, posed) : observed(p, p.playerIdx, posed);
  };
  // `directed` is the client's own (it knows how it joined); the match constants come with the map (24.3).
  return { ...rest, contestantsActive: frame.players.filter(p => p.role === 'contestant' && p.status === 'active').length,
    ...(frame.bodies ? presentationFields(d, viewer, wire) : {}),
    ...(frame.bodies && viewer ? tetherState(frame, viewer, relations.byActor(viewer.playerIdx)?.id) : {}),
    ...(viewer ? { self: projectPlayer(viewer, true) } : {}),
    players: d.players.filter(p => p !== viewer).map(p => projectPlayer(p)),
    items: d.items.map(item => { const projected = projectedItem(item, wire, projectedItems); return itemBodies.has(item.id) ? omitPose(projected) : projected; }), gates: frame.gates,
    traps: d.traps.map(trap => trapFields(trap)), projectiles: d.projectiles.map(shot => projectileFields(shot, wire)),
    effects: d.effects.map(effect => effectFields(effect, wire)), events: frame.events?.map(event => eventFields(event, wire)) };
}
/**
 * Whether the viewer's own body is tethered and whether it has a hook out, which hidden endpoints may omit from the
 * projected tethers and flights. The old world's frame answers from its private state. A frame on the new tick's path
 * (`tick-frame.ts`) has none, and answers from the whole presentation, before any view filtering: a tether is a hook's
 * pull and its caster is end `a`.
 */
function tetherState(frame: Snapshot, viewer: Player<ItemKey> & { playerIdx: PlayerIdx }, own: unknown) {
  if (frame.physics) return { predictionTethered: frame.physics.world.constraints.some(c => c.a === `actor:${viewer.id}` || c.b === `actor:${viewer.id}`),
    ...(frame.physics.hooks ? { hookActive: frame.physics.hooks.some(hook => hook.caster === viewer.id) } : {}) };
  const tethers = frame.tethers ?? [];
  return { predictionTethered: own !== undefined && tethers.some(t => t.a === own || t.b === own),
    hookActive: (frame.hookFlights ?? []).some(hook => hook.casterIdx === viewer.playerIdx) || (own !== undefined && tethers.some(t => t.a === own)) };
}
/** What a frame's physics presentation holds: the old world's capture, or the new tick's, which has no private `physics`. */
export type FramePresentation = Omit<PhysicsPresentation, 'physics'> & { physics?: PhysicsPresentation['physics'] };
export function snapshot(s: Game): Snapshot {
  // Inclusive; presentation timing accumulates numeric capture and physical item pose publication.
  start('sim.snapshot');
  try { return frameOf(s, capturePhysicsPresentation(s)); }
  finally { stop('sim.snapshot'); }
}
/** The game's frame with `captured` as its physics presentation (`snapshot` captures the old world's). */
function frameOf(s: Game, captured: FramePresentation | undefined): Snapshot {
  try {
    const physics = captured?.physics;
    start('sim.snapshot.presentation');
    const ground = publishItems(s);
    const presentation = captured ? { physicsProfile: captured.physicsProfile, bodies: captured.bodies, tethers: captured.tethers, ...(captured.hookFlights ? { hookFlights: captured.hookFlights } : {}) } : undefined;
    stop('sim.snapshot.presentation');
    start('sim.snapshot.clone');
    // The ground and gate lists are shared, not cloned: their records are frozen and replaced when they change.
    // The physics state and its presentation are already the frame's own, apart from frozen shared records.
    const frame: Snapshot = structuredClone({ version: s.version, duration: s.content.durationTicks, cellChargeTicks: s.content.cellChargeTicks, tick: s.tick, phase: s.phase, rng: s.rng, hazardX: s.hazardX, slots: s.slots, serial: s.serial, players: s.players, items: null, gates: null, traps: s.traps, projectiles: s.projectiles, effects: s.effects, events: s.events, ...(s.itemSerial !== undefined ? { itemSerial: s.itemSerial, scatterSerial: s.scatterSerial } : {}) }) as unknown as Snapshot;
    frame.items = compactItems(ground, captured?.bodies);
    shareItemPublication(ground, frame.items);
    const actors = bodyRelations(captured?.bodies);
    frame.players = frame.players.map((p, i) => { const player = { ...p, playerIdx: i as PlayerIdx }; return actors.byActor(i as PlayerIdx) ? omitPose(player) : player; });
    frame.gates = dynamicGates(publishGates(s));
    return physics ? Object.assign(frame, { physics }, presentation) : presentation ? Object.assign(frame, presentation) : frame;
  }
  finally { stop('sim.snapshot.clone'); }
}
