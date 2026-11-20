import { itemIdForLabel, itemLabel } from '../item-instances.ts';
import { gateShape } from '../gate-index.ts';
import { physicsRefusal, templateRow } from '../physics/world.ts';
import type { PhysicsExports, PhysicsWorld } from '../physics/world.ts';
import type { BodySpec } from '../physics/types.ts';
import type { CoreExports } from '../core.ts';
import { actorRadius } from './actor-physics.ts';
import { admitItem, groundItem, itemsNear, unadmittedItems } from './ground-items.ts';
import { markPhysicsDiscontinuity } from './physics-runtime.ts';
import type { PhysicsRuntime, PendingAttachment } from './physics-runtime.ts';
import { physicsGate } from './physics-geometry.ts';
import { sightOf } from './sight-runtime.ts';
import type { Game, GroundItem, ItemId, Player, Vec2 } from '../types.ts';

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
const A_HEADER = 11, ACTOR_STRIDE = 5, GATE_STRIDE = 8 + BODY_ROW, HELD_STRIDE = 2;
const B_HEADER = 8, LAUNCH_STRIDE = 6, WAITING_STRIDE = 4;
const OP_QUEUED = 1, OP_COMMIT = 2, OP_TRANSFORM = 3, OP_MARK = 4, OP_ACTOR = 5, OP_POSE = 6, OP_RETRY = 7, OP_GATE = 8, OP_ITEM = 9;
const MARK_PLACED = 0;
const TEMPLATE_CONTESTANT = 0, TEMPLATE_GLADIATOR = 1, TEMPLATE_LOOT = 2;
const E_NO_PLACEMENT = -17, E_DISCONTINUITY_CAPACITY = -18, E_UNREPRESENTABLE = -19, E_INITIAL_SPEED = -20;

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const actorKey = (p: Player) => `actor:${p.id}`;
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

/** Each runtime's ground item by held body ID, so a body's label is parsed once. */
const heldItems = new WeakMap<PhysicsRuntime, Map<string, ItemId>>();
function heldItem(s: Game, r: PhysicsRuntime, id: string): ItemId {
  let ids = heldItems.get(r);
  if (!ids) heldItems.set(r, ids = new Map());
  let item = ids.get(id);
  if (item === undefined) ids.set(id, item = itemIdForLabel(s, id.slice(ITEM_PREFIX.length))!);
  return item;
}

/** The call's core and handles: the world's and the map's, from the one core both are bound to. */
function handles(s: Game, r: PhysicsRuntime, openMask: boolean): { core: Core; world: number; collision: number; index: number; gates: number } {
  const { core, world } = r.world.boundaryCall();
  const map = sightOf(s).queryHandles(s.map, openMask);
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

/** Applies a sync call's log in order, then throws its refusal, if any, with the message the TypeScript threw. */
function apply(s: Game, r: PhysicsRuntime, out: Float64Array, markTick: number, items: readonly GroundItem[] = []): void {
  const world = r.world, t = templatesOf(s);
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
      if (out[at + 3]) s.gates[index]!.open = true;
      r.gates[index] = out[at + 2]!; at += 4;
    } else if (op === OP_ITEM) {
      const id = world.idOf(out[at + 1]!);
      if (out[at + 2]) { r.items.add(id); admitItem(s, items[out[at + 3]!]!); } else r.items.delete(id);
      at += 4;
    } else throw new Error(`unknown boundary log entry ${op}`);
  }
  world.adoptQueue(out[4]!);
  const code = out[0]!;
  if (code === 0) return;
  if (code === E_NO_PLACEMENT) throw new Error(`no legal physics placement for ${s.players[out[2]!]!.id}`);
  if (code === E_DISCONTINUITY_CAPACITY) throw new RangeError('physics discontinuity capacity');
  if (code === E_UNREPRESENTABLE) throw new TypeError('physics value must be finite and within representable bounds');
  if (code === E_INITIAL_SPEED) throw new RangeError('initial physics speed requires swept-query-or-explicit-teleport');
  throw physicsRefusal(code, out[1]! >= 0 ? world.idOf(out[1]!) : '');
}

/**
 * The body sync's first call in the core: the actors, the gates, then the item bodies whose items left the ground
 * (`synchronize`, `synchronizePhysicalItems`). Returns whether an item could be admitted, for `synchronizeItems`.
 */
export function synchronizeBodies(s: Game, r: PhysicsRuntime, markTick: number, admit: boolean): boolean {
  const world = r.world, t = templatesOf(s);
  const roster = new Map(s.players.map((p, i) => [p, i]));
  const active = [...s.players].sort((a, b) => compare(a.id, b.id)).filter(p => p.status === 'active');
  const gates: number[] = [];
  for (const index of r.gateOrder) if (r.gates[index] !== (s.gates[index]!.open ? 1 : 2)) gates.push(index);
  // Only the item bodies whose items left the ground: the core removes those and passes over the rest.
  const held: string[] = [];
  for (const id of r.items) if (!groundItem(s, heldItem(s, r, id))) held.push(id);
  const markers = r.discontinuities;
  const words = A_HEADER + 2 * BODY_ROW + active.length * ACTOR_STRIDE + r.actors.size + gates.length * GATE_STRIDE
    + held.length * HELD_STRIDE + markers.length;
  // Keys are interned before the input is viewed: interning is a core call of its own.
  const actorKeys = active.map(p => world.key(actorKey(p))), known = [...r.actors].map(id => world.key(id));
  const gateKeys = gates.map(index => world.key(`gate:${s.gates[index]!.id}`));
  const gateRows = gates.map(index => s.gates[index]!.open ? undefined : templateRow(physicsGate(s.gates[index]!)));
  const heldRows = held.map(id => [world.key(id), 0] as const);
  const markerKeys = markers.map(entry => world.key(entry.id));
  const { core, world: native, collision, gates: gateSet } = handles(s, r, true);
  const view = input(core, native, words);
  view.set([s.tick, admit ? 1 : 0, r.itemLaunches.size ? 1 : 0, s.players.length, s.content.worldPhysics.dropReserve ?? 0,
    r.discontinuityCapacity, active.length, known.length, gates.length, held.length, markers.length]);
  view.set(t.rows[0]!, A_HEADER); view.set(t.rows[1]!, A_HEADER + BODY_ROW);
  let at = A_HEADER + 2 * BODY_ROW;
  for (let i = 0; i < active.length; i++, at += ACTOR_STRIDE) {
    const p = active[i]!;
    view[at] = actorKeys[i]!; view[at + 1] = roster.get(p)!; view[at + 2] = p.role === 'gladiator' ? 1 : 0; view[at + 3] = p.x; view[at + 4] = p.y;
  }
  view.set(known, at); at += known.length;
  for (let i = 0; i < gates.length; i++, at += GATE_STRIDE) {
    const index = gates[i]!, gate = s.gates[index]!, box = gateShape(gate);
    // `overlapsDynamicBox`'s box, as it centres `gateShape`.
    view.set([index, gate.open ? 1 : 0, r.gates[index]!, box.w / 2, box.h / 2, box.x + box.w / 2, box.y + box.h / 2, gateKeys[i]!], at);
    if (gateRows[i]) view.set(gateRows[i]!, at + 8);
  }
  for (const [key, onGround] of heldRows) { view[at++] = key; view[at++] = onGround; }
  view.set(markerKeys, at);
  core.physics_sync_bodies(native, collision, gateSet);
  const out = output(core, native);
  const room = out[3] === 1;
  apply(s, r, out, markTick);
  return room;
}

/** The first chunk of items awaiting a body that the admission packs; each further chunk is twice the last. */
const FIRST_CHUNK = 32;

/**
 * The sync's item admission, when the first call found room: launched items, then those awaiting a body, in ID
 * order. Those are packed in chunks, the next only while the last ran out with room left, so a world with room for
 * one more item packs a few of the thousands a large map may hold, as the TypeScript visited only those.
 */
export function synchronizeItems(s: Game, r: PhysicsRuntime, markTick: number): void {
  const launches: GroundItem[] = [];
  for (const id of [...r.itemLaunches.keys()].sort((a, b) => compare(itemLabel(s, a), itemLabel(s, b)))) {
    const item = groundItem(s, id);
    if (item) launches.push(item);
  }
  // The items already offered: still awaiting a body, they lead the admission order, so a chunk skips them.
  const offered = new Set<ItemId>();
  for (let size = FIRST_CHUNK, first = true; ; size *= 2, first = false) {
    const chunk: GroundItem[] = [];
    let more = false;
    for (const item of unadmittedItems(s, r.items)) {
      if (offered.has(item.id)) continue;
      if (chunk.length === size) { more = true; break; }
      offered.add(item.id);
      // A launched item is the launches' to place; the loop would skip it.
      if (!r.itemLaunches.has(item.id)) chunk.push(item);
    }
    const room = admitChunk(s, r, markTick, first ? launches : [], chunk);
    if (!room || !more) break;
  }
  r.itemLaunches.clear();
}

/** One call of the admission: the launches, then one chunk of the items awaiting a body. Returns whether the chunk ran out with room left. */
function admitChunk(s: Game, r: PhysicsRuntime, markTick: number, launches: readonly GroundItem[], waiting: readonly GroundItem[]): boolean {
  const world = r.world, t = templatesOf(s);
  const active = s.players.filter(p => p.status === 'active');
  const items = [...launches, ...waiting];
  const keys = items.map(item => itemKey(s, world, item.id)), held = [...r.items].map(id => world.key(id));
  const markerKeys = r.discontinuities.map(entry => world.key(entry.id));
  const words = B_HEADER + BODY_ROW + active.length * 3 + held.length + launches.length * LAUNCH_STRIDE + waiting.length * WAITING_STRIDE + markerKeys.length;
  const { core, world: native, collision, gates } = handles(s, r, true);
  const view = input(core, native, words);
  view.set([Math.max(0, s.players.length - r.actors.size), s.content.worldPhysics.dropReserve ?? 0, r.discontinuityCapacity,
    launches.length, waiting.length, active.length, held.length, markerKeys.length]);
  view.set(t.rows[2]!, B_HEADER);
  let at = B_HEADER + BODY_ROW;
  for (const p of active) { view[at++] = p.x; view[at++] = p.y; view[at++] = actorRadius(s, p); }
  view.set(held, at); at += held.length;
  for (let i = 0; i < launches.length; i++, at += LAUNCH_STRIDE) {
    const item = launches[i]!, motion = r.itemLaunches.get(item.id)!;
    view.set([keys[i]!, i, item.x, item.y, motion.x, motion.y], at);
  }
  for (let i = launches.length; i < items.length; i++, at += WAITING_STRIDE) {
    const item = items[i]!;
    view.set([keys[i]!, i, item.x, item.y], at);
  }
  view.set(markerKeys, at);
  core.physics_sync_items(native, collision, gates);
  const out = output(core, native), room = out[3] === 1;
  apply(s, r, out, markTick, items);
  return room;
}

/**
 * Phase 1's admission of the pending impulses and attachments, decided in the core: an impulse whose body keeps
 * its generation, an attachment whose actors keep theirs, within reach and in the clear. The admitted are queued
 * here, in order, so the world's records take their specs as before.
 */
export function admitPending(s: Game, r: PhysicsRuntime): void {
  const impulses = r.pendingImpulses.splice(0);
  // Read, not drained: as before, the attachment queue empties only once every admitted impulse has queued, so an
  // impulse the world refuses leaves the attachments pending (review 975).
  const attachments = [...r.pendingAttachments].sort((a, b) => compare(a.id, b.id));
  if (!impulses.length && !attachments.length) return;
  const world = r.world;
  const keyOf = (id: string) => world.hasBody(id) ? world.key(id) : -1;
  const impulseKeys = impulses.map(impulse => keyOf(impulse.id));
  const ends = attachments.map(a => [keyOf(a.a), keyOf(a.b)] as const);
  // Only an attachment's reach reads the gates.
  const { core, world: native, index, gates } = handles(s, r, attachments.length > 0);
  const view = input(core, native, 2 + impulses.length * 2 + attachments.length * 7);
  view[0] = impulses.length; view[1] = attachments.length;
  impulses.forEach((impulse, i) => { view[2 + 2 * i] = impulseKeys[i]!; view[3 + 2 * i] = impulse.generation; });
  const base = 2 + impulses.length * 2;
  attachments.forEach((a, i) => view.set([ends[i]![0], ends[i]![1], r.actors.has(a.a) ? 1 : 0, r.actors.has(a.b) ? 1 : 0,
    a.generationA, a.generationB, a.maxDistance], base + 7 * i));
  core.physics_admit_pending(native, index, gates);
  const pass = Array.from(output(core, native).subarray(OUT_HEADER), flag => flag === 1);
  impulses.forEach((impulse, i) => { if (pass[i]) world.queueImpulse(impulse.id, impulse.value); });
  r.pendingAttachments.splice(0);
  attachments.forEach((attachment: PendingAttachment, i) => { if (pass[impulses.length + i]) world.queueAddConstraint(attachment); });
}

/** The placement search in the core, for `p` nearest `origin`, clear of the `admitted` actors as they stand. */
export function placeInCore(s: Game, r: PhysicsRuntime, p: Player, admitted: readonly Player[], origin: Vec2): Vec2 | null {
  const { core, world, collision, gates } = handles(s, r, true);
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
  const { core, world, collision, index, gates } = handles(s, r, true);
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
