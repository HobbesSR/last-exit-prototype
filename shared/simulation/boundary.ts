import { itemLabel } from '../item-instances.ts';
import { physicsRefusal, templateRow } from '../physics/world.ts';
import type { PhysicsExports, PhysicsWorld } from '../physics/world.ts';
import type { BodySpec } from '../physics/types.ts';
import type { CoreExports } from '../core.ts';
import { actorRadius } from './actor-physics.ts';
import { admitItem, groundItem, itemsNear } from './ground-items.ts';
import { markPhysicsDiscontinuity, mirrorPendingQueues } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import { physicsGate } from './physics-geometry.ts';
import { sightOf } from './sight-runtime.ts';
import { playersStale, uploadPlayers } from './player-store.ts';
import { ensureGround } from './ground-store.ts';
import { sawHooks, syncHooks } from './hook.ts';
import { HZ } from './rules.ts';
import { writeDoor } from './doors.ts';
import type { Game, ItemId, Player, Vec2 } from '../types.ts';

// The adapter for the tick boundary's body work in the core (`rust/core/src/boundary.rs`, #1234, docs/27 "The
// state flip", step 5b.3): the body sync, phase 1's pending admission and the placement search, and the drop
// planner's spiral search (`scatter.rs`, step 5c.1). The state stays
// here (D1). Each call packs what its rule reads into the world's boundary input, and the core runs the rule,
// queueing, committing and teleporting in the world in the order the TypeScript did. What it wrote to the records
// here comes back as a log, applied in order when the call returns:
// - **world records** go to the physics world (`adoptQueued`, `adoptCommit`, `adoptTeleport`), which builds the
//   same frozen specs `queueAddBody` built;
// - **the runtime's bookkeeping** (its actor, item and gate state and the discontinuity markers) and the players'
//   poses and retries are written here.
// A refusal stops the core where the TypeScript threw; the log holds what was done before it, and this throws the
// old message after applying it. Views are made after every core call, since a call may grow WASM memory.

type Core = CoreExports & PhysicsExports;

// The layout of `boundary.rs`.
const OUT_HEADER = 6, BODY_ROW = 22;
/** The sync's input header (`boundary::S_HEADER`): tick, admit, the markers' capacity, the roster's size, the markers. */
const S_HEADER = 5;
const OP_QUEUED = 1, OP_COMMIT = 2, OP_TRANSFORM = 3, OP_MARK = 4, OP_ACTOR = 5, OP_POSE = 6, OP_RETRY = 7, OP_GATE = 8, OP_ITEM = 9, OP_ATTACHMENT = 10;
/** A hook the sync's reconcile removed (`hooks::OP_REMOVED`), by its index in the hooks as the sync began. */
const OP_HOOK_REMOVED = 20;
const MARK_PLACED = 0;
const TEMPLATE_CONTESTANT = 0, TEMPLATE_GLADIATOR = 1, TEMPLATE_LOOT = 2;
const E_NO_PLACEMENT = -17, E_DISCONTINUITY_CAPACITY = -18, E_UNREPRESENTABLE = -19, E_INITIAL_SPEED = -20;

const ITEM_PREFIX = 'item:';

/** The specs a game's queued bodies are built from, and their rows: fixed by the match's pinned content. */
interface Templates { actor: Record<'contestant' | 'gladiator', BodySpec>; loot: BodySpec; rows: Float64Array[] }
const templates = new WeakMap<Game['content'], Templates>();
function templatesOf(s: Game): Templates {
  let cached = templates.get(s.content);
  if (!cached) {
    const actor = (role: 'contestant' | 'gladiator'): BodySpec => ({ id: 'template', kind: 'actor',
      shape: { kind: 'circle', radius: s.content.actorPhysics.geometry[role].bodyRadius }, x: 0, y: 0, mass: 1, friction: 0, restitution: 0,
      maxSpeed: s.content.actorPhysics.maxSpeed });
    const profile = s.content.worldPhysics.loot;
    const loot: BodySpec = { id: 'template', kind: 'prop', collisionProfile: 'loot', shape: { kind: 'circle', radius: profile.radius },
      x: 0, y: 0, mass: profile.mass, friction: 0, restitution: 0, linearDamping: profile.linearDamping, angularDamping: profile.angularDamping,
      vx: 0, vy: 0 };
    const specs = { contestant: actor('contestant'), gladiator: actor('gladiator') };
    cached = { actor: specs, loot, rows: [templateRow(specs.contestant), templateRow(specs.gladiator), templateRow(loot)] };
    templates.set(s.content, cached);
  }
  return cached;
}

/** Each world's keys for ground items' bodies, so an item's ID string is built and interned once. */
const itemKeys = new WeakMap<PhysicsWorld, Map<ItemId, number>>();
function itemKey(s: Game, world: PhysicsWorld, id: ItemId): number {
  let keys = itemKeys.get(world);
  if (!keys) itemKeys.set(world, keys = new Map());
  let key = keys.get(id);
  if (key === undefined) keys.set(id, key = world.key(`${ITEM_PREFIX}${itemLabel(s, id)}`));
  return key;
}

/** The call's core and handles: the world's and the map's, from the one core both are bound to. */
function handles(s: Game, r: PhysicsRuntime): { core: Core; world: number; collision: number; index: number; gates: number } {
  const { core, world } = r.world.boundaryCall();
  const map = sightOf(s).queryHandles(s.map);
  if (map.core !== core) throw new Error('the physics world and sight are bound to different cores');
  return { core, world, collision: map.collision, index: map.index, gates: map.gates };
}

/** The boundary input, resized to `words`: viewed after the resize, which may grow the memory. */
function input(core: Core, world: number, words: number): Float64Array {
  const pointer = core.physics_boundary_input(world, words) >>> 0;
  return new Float64Array(core.memory.buffer, pointer, words);
}
/** The call's output: its header and log, viewed after the call. */
function output(core: Core, world: number): Float64Array {
  const pointer = core.physics_boundary_output(world) >>> 0;
  return new Float64Array(core.memory.buffer, pointer, new Float64Array(core.memory.buffer, pointer, OUT_HEADER)[5]!);
}

/**
 * Apply a sync the core ran inside another run (#1214 stage 6d.6b): phase 3's drops. `markTick` is the sync's, as
 * `r.synchronize()` gave it there. The queues' mirror follows, refusal or not, as `synchronizeInCore` does.
 */
export function applySyncLog(s: Game, r: PhysicsRuntime, out: Float64Array, markTick: number): void {
  const queued = r.pendingImpulses.length > 0 || r.pendingAttachments.length > 0;
  try { apply(s, r, out, markTick); } finally { if (queued) mirrorPendingQueues(r); }
}

/**
 * Make the core ready for a sync it runs inside another run (#1214 stage 6d.6b), as `synchronizeInCore` does before its
 * call: the ground store current, the hooks' mirror uploaded if Node changed it, the launches handed over and the sync's
 * settings uploaded.
 */
export function prepareInRunSync(s: Game, r: PhysicsRuntime): void {
  const world = r.world;
  ensureGround(s, r);
  syncHooks(r);
  const launches = [...r.itemLaunches].map(([id, motion]) => [itemKey(s, world, id), motion.x, motion.y] as const);
  r.itemLaunches.clear();
  const { core, world: native } = world.boundaryCall();
  configureSync(s, r, core, native);
  if (launches.length) {
    const view = input(core, native, launches.length * 3);
    launches.forEach((row, i) => view.set(row, i * 3));
    (core as Core & { physics_launch(world: number, count: number): void }).physics_launch(native, launches.length);
  }
}

/** Applies a sync call's log in order, then throws its refusal, if any, with the message the TypeScript threw. */
function apply(s: Game, r: PhysicsRuntime, out: Float64Array, markTick: number): void {
  const world = r.world, t = templatesOf(s), hooks = r.hooks, removed = new Set<number>();
  for (let at = OUT_HEADER; at < out.length;) {
    const op = out[at]!;
    if (op === OP_QUEUED) {
      const key = out[at + 1]!, template = out[at + 2]!, ref = out[at + 3]!;
      const x = out[at + 4]!, y = out[at + 5]!, vx = out[at + 6]!, vy = out[at + 7]!, id = world.idOf(key);
      world.adoptQueued(key, template === TEMPLATE_CONTESTANT || template === TEMPLATE_GLADIATOR
        ? { ...t.actor[template === TEMPLATE_CONTESTANT ? 'contestant' : 'gladiator'], id, x, y }
        : template === TEMPLATE_LOOT ? { ...t.loot, id, x, y, vx, vy } : physicsGate(s.gates[ref]!));
      at += 8;
    } else if (op === OP_COMMIT) {
      world.adoptCommit(out[at + 1]!, out, at + 2);
      at += 3 + out[at + 2]! * 2;
    } else if (op === OP_TRANSFORM) {
      world.adoptTeleport(out[at + 1]!); at += 2;
    } else if (op === OP_MARK) {
      const generation = out[at + 3]!;
      markPhysicsDiscontinuity(r, { id: world.idOf(out[at + 2]!), generation: generation < 0 ? undefined! : generation,
        kind: out[at + 1] === MARK_PLACED ? 'placed' : 'removed', tick: markTick });
      at += 4;
    } else if (op === OP_ACTOR) {
      const id = world.idOf(out[at + 1]!);
      if (out[at + 2]) r.actors.add(id); else r.actors.delete(id);
      at += 3;
    } else if (op === OP_POSE) {
      const p = s.players[out[at + 1]!]!;
      p.x = out[at + 2]!; p.y = out[at + 3]!; at += 4;
    } else if (op === OP_RETRY) {
      const p = s.players[out[at + 1]!]!;
      p.status = 'respawning'; p.respawnAt = out[at + 2]!; at += 3;
    } else if (op === OP_GATE) {
      const index = out[at + 1]!;
      // A refused close: the core has kept the gate open in its set, and the mirror follows.
      if (out[at + 3]) writeDoor(s.gates[index]!, 'open', true);
      r.gates[index] = out[at + 2]!; at += 4;
    } else if (op === OP_ATTACHMENT) {
      // An attachment the admission queued: its spec, as `validateConstraint` gave it, for the world's records.
      const key = out[at + 1]!;
      world.adoptQueuedConstraint(key, { id: world.idOf(key), a: world.idOf(out[at + 2]!), b: world.idOf(out[at + 3]!), maxDistance: out[at + 4]! });
      at += 5;
    } else if (op === OP_HOOK_REMOVED) {
      removed.add(out[at + 1]!); at += 2;
    } else if (op === OP_ITEM) {
      const id = world.idOf(out[at + 1]!);
      // An admitted item names its record by ID (6d.3).
      if (out[at + 2]) { r.items.add(id); admitItem(s, groundItem(s, out[at + 3]! as ItemId)!); } else r.items.delete(id);
      at += 4;
    } else throw new Error(`unknown boundary log entry ${op}`);
  }
  // The hooks the reconcile removed leave the mirror, which then matches the core's again (6d.4).
  if (removed.size) { r.hooks = hooks.filter((_, i) => !removed.has(i)); sawHooks(r); }
  world.adoptQueue(out[4]!);
  const code = out[0]!;
  if (code === 0) return;
  if (code === E_NO_PLACEMENT) throw new Error(`no legal physics placement for ${s.players[out[2]!]!.id}`);
  if (code === E_DISCONTINUITY_CAPACITY) throw new RangeError('physics discontinuity capacity');
  if (code === E_UNREPRESENTABLE) throw new TypeError('physics value must be finite and within representable bounds');
  if (code === E_INITIAL_SPEED) throw new RangeError('initial physics speed requires swept-query-or-explicit-teleport');
  throw physicsRefusal(code, out[1]! >= 0 ? world.idOf(out[1]!) : '');
}

/** The worlds whose sync settings are uploaded, with the content they came from (pinned per match). */
const syncConfigured = new WeakMap<PhysicsWorld, Game['content']>();
/**
 * The sync's match-pinned settings, once per world (#1214 stage 6d.6): the three body templates, the drop reserve and the
 * hook tuning, in `World::configure_sync`'s layout.
 */
function configureSync(s: Game, r: PhysicsRuntime, core: Core, native: number): void {
  if (syncConfigured.get(r.world) === s.content) return;
  const t = templatesOf(s), h = s.content.hook, words = 3 * BODY_ROW + 1 + 11;
  const view = input(core, native, words);
  t.rows.forEach((row, k) => view.set(row.subarray(0, BODY_ROW), k * BODY_ROW));
  view.set([s.content.worldPhysics.dropReserve ?? 0, h.range, h.breakDistance, h.durationTicks, h.standoff, h.targetDistance,
    h.pullSpeed, HZ, h.stiffness, h.damping, h.maxForce, h.speed], 3 * BODY_ROW);
  core.physics_sync_configure(native);
  syncConfigured.set(r.world, s.content);
}

/**
 * The whole body sync in one core call (`boundary::synchronize`, #1214 stage 6d.6): the actors, the gates and the item
 * bodies whose records left the ground; the item admission when `admit` and there is room; the pending queues'
 * generation filter; and the hooks' reconcile. The players, launches, ground, queues and hooks are the core's; only the
 * discontinuity markers cross, since Node's tick trims them (`tick.ts`). The log is applied in order, then the queues'
 * mirror is read back, and a refusal is thrown last, as each of the four calls this replaces threw.
 */
export function synchronizeInCore(s: Game, r: PhysicsRuntime, markTick: number, admit: boolean): void {
  const world = r.world;
  ensureGround(s, r);
  // The hooks' mirror, when Node changed it without the facts (`syncHooks`), as `reconcileHooks` uploaded it first.
  syncHooks(r);
  // Launches made since the last sync are handed over now; the core keeps them until an admission takes them.
  const launches = [...r.itemLaunches].map(([id, motion]) => [itemKey(s, world, id), motion.x, motion.y] as const);
  r.itemLaunches.clear();
  const markerKeys = r.discontinuities.map(entry => world.key(entry.id));
  const queued = r.pendingImpulses.length > 0 || r.pendingAttachments.length > 0;
  const { core, world: native, collision, gates } = handles(s, r);
  const swept = sightOf(s).sweptHandle(s.map);
  if (playersStale(r)) uploadPlayers(s, r, core, native);
  configureSync(s, r, core, native);
  if (launches.length) {
    const view = input(core, native, launches.length * 3);
    launches.forEach((row, i) => view.set(row, i * 3));
    (core as Core & { physics_launch(world: number, count: number): void }).physics_launch(native, launches.length);
  }
  const view = input(core, native, S_HEADER + markerKeys.length);
  view.set([s.tick, admit ? 1 : 0, r.discontinuityCapacity, s.players.length, markerKeys.length]);
  view.set(markerKeys, S_HEADER);
  core.physics_sync(native, collision, gates, swept);
  try { apply(s, r, output(core, native), markTick); } finally {
    // The core drops the entries whose bodies changed generation, and the mirror follows (6d.5).
    if (queued) mirrorPendingQueues(r);
  }
}

/**
 * Hand the world its gates' keys and closed bodies' rows, once (#1214 stage 6d.2): the body sync reconciles each gate's
 * body in the core from them and the door state. `createGame` calls it before the first sync.
 */
export function uploadGateBodies(s: Game, r: PhysicsRuntime): void {
  const world = r.world, keys = s.gates.map(gate => world.key(`gate:${gate.id}`));
  const rows = s.gates.map(gate => templateRow(physicsGate({ ...gate, open: false })));
  const { core, world: native } = world.boundaryCall() as unknown as { core: Core & { physics_gates_load(world: number, count: number): void }; world: number };
  const words = s.gates.length * (1 + BODY_ROW), view = new Float64Array(core.memory.buffer, core.physics_boundary_input(native, words) >>> 0, words);
  s.gates.forEach((_, i) => { view[i * (1 + BODY_ROW)] = keys[i]!; view.set(rows[i]!.subarray(0, BODY_ROW), i * (1 + BODY_ROW) + 1); });
  core.physics_gates_load(native, s.gates.length);
}

/**
 * Phase 1's admission of the pending impulses and attachments, in the core from its own queues (#1214 stage 6d.5): the
 * admitted are queued there, and each queued attachment's spec is adopted here, as `queueAddConstraint` made it. The
 * mirror follows the queues, refusal or not.
 */
export function admitPending(s: Game, r: PhysicsRuntime): void {
  if (!r.pendingImpulses.length && !r.pendingAttachments.length) return;
  const { core, world: native, index, gates } = handles(s, r);
  core.physics_admit_pending(native, index, gates);
  try { apply(s, r, output(core, native), s.tick); } finally { mirrorPendingQueues(r); }
}

/** The placement search in the core, for `p` nearest `origin`, clear of the `admitted` actors as they stand. */
export function placeInCore(s: Game, r: PhysicsRuntime, p: Player, admitted: readonly Player[], origin: Vec2): Vec2 | null {
  const { core, world, collision, gates } = handles(s, r);
  const view = input(core, world, 4 + admitted.length * 3);
  view[0] = actorRadius(s, p); view[1] = origin.x; view[2] = origin.y; view[3] = admitted.length;
  admitted.forEach((q, i) => { view[4 + 3 * i] = q.x; view[5 + 3 * i] = q.y; view[6 + 3 * i] = actorRadius(s, q); });
  core.physics_place(world, collision, gates);
  const out = output(core, world);
  return out[OUT_HEADER] === 1 ? { x: out[OUT_HEADER + 1]!, y: out[OUT_HEADER + 2]! } : null;
}

/** How far a record can be from a drop's origin and still matter: the spiral's farthest spot and its spacing (`scatter.rs`), with a unit spare. */
const SCATTER_REACH = 372 + 32 + 1;

/**
 * The drop planner's spiral search in the core (`rust/core/src/scatter.rs`, #1228): the first spot near `origin`
 * from `phase` that is reachable, clear of the map, of `items` and `points` by more than 32, and where a loot body
 * fits beside the solid props and the active actors. Only the records of `items` within reach of the spiral are
 * packed: the ground's grid finds them when `items` is the ground, and a staged list (a swap's) is filtered whole,
 * as the TypeScript read it whole.
 */
export function scatterInCore(s: Game, r: PhysicsRuntime, origin: Vec2, phase: number, items: readonly Vec2[],
  points: readonly Vec2[]): Vec2 | undefined {
  const near = !Number.isFinite(origin.x) || !Number.isFinite(origin.y) ? items
    : items === s.items ? itemsNear(s, origin, SCATTER_REACH)
      // A record with a NaN coordinate fails every spot's spacing test, whatever its other coordinate, so it is kept,
      // as the grid keeps it loose (review 977).
      : items.filter(item => Number.isNaN(item.x) || Number.isNaN(item.y)
        || Math.abs(item.x - origin.x) <= SCATTER_REACH && Math.abs(item.y - origin.y) <= SCATTER_REACH);
  const actors = s.players.filter(p => p.status === 'active'), taken = near.length + points.length;
  const { core, world, collision, index, gates } = handles(s, r);
  const view = input(core, world, 6 + actors.length * 3 + taken * 2);
  view[0] = origin.x; view[1] = origin.y; view[2] = phase; view[3] = s.content.worldPhysics.loot.radius;
  view[4] = actors.length; view[5] = taken;
  let at = 6;
  for (const p of actors) { view[at++] = p.x; view[at++] = p.y; view[at++] = actorRadius(s, p); }
  for (const list of [near, points]) for (const spot of list) { view[at++] = spot.x; view[at++] = spot.y; }
  core.physics_scatter(world, collision, index, gates);
  const out = output(core, world);
  return out[OUT_HEADER] === 1 ? { x: out[OUT_HEADER + 1]!, y: out[OUT_HEADER + 2]! } : undefined;
}
