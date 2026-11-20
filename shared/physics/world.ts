import { PHYSICS_SUBSTEP_SECONDS, physicsSpeedLimit } from './motion-limits.ts';
import { validateConstraint } from './constraints.ts';
import { UNITS_PER_METRE } from './units.ts';
import type { BodySpec, ConstraintSpec, MotorIntent, PhysicsContact, PhysicsSnapshot, Point, Transform } from './types.ts';
import { initCore, type CoreExports } from '../core.ts';
import { hypot } from '../math.ts';

// The adapter between the game's queue-and-commit physics interface and the Rust core's world, which holds Rapier
// (`rust/core/src/physics.rs`, #1192) and, since #1232, the world's bookkeeping (`rust/core/src/world.rs`): the
// body records, generations, the command queues and their commit order, the constraints, the contacts and every
// ordering by ID (docs/27, "The state flip", step 5b). This file keeps validation, an intern table from ID strings to
// the core's keys, and the frozen spec, motor and lifetime objects snapshots share (#655), which it updates from the
// facts a commit reports. The adapter rules are 27's:
// - **Flat buffers.** Rows go in through one `Float64Array` written into a buffer the core owns; results are read
//   through a view of another.
// - **Views are made after each call,** because any allocation may grow WASM memory and detach the
//   old `memory.buffer`.
// - **Pointers are read with `>>> 0`,** since WASM returns them as signed 32-bit integers.

// World units per Rapier metre, the adapter's short name for units.ts's UNITS_PER_METRE.
const SCALE = UNITS_PER_METRE;
const SUBSTEPS = 4;
const DT = PHYSICS_SUBSTEP_SECONDS;
const MAX_PENDING = 1024;
const MAX_EVENTS = 8192;
// Keep inputs representable through world-unit conversion and the f32 backend.
// This is an admission guard, not a promise of useful precision at this extent.
const MAX_MAGNITUDE = 1e9;
const STATIC_GROUP = 0x0001;
const ACTOR_GROUP = 0x0002;
const PROP_GROUP = 0x0004;
const LOOT_GROUP = 0x0008;
// The core's encodings and row widths (`rust/core/src/world.rs`, `physics.rs`).
const KIND = { static: 0, actor: 1, prop: 2 } as const;
const SHAPE = { circle: 0, box: 1, convex: 2 } as const;
const BODY_ROW = 22, CONSTRAINT_ROW = 14, STEP_HEADER = 4, SNAPSHOT_STRIDE = 9, EVENT_STRIDE = 4, CONTACT_STRIDE = 7,
  FORCE_STRIDE = 5, DRAG_STRIDE = 4;

/** The core's physics exports (`rust/core/src/lib.rs`). A world and every pointer are numbers; IDs cross as keys. */
export interface PhysicsExports {
  physics_world_new(): number;
  physics_world_free(world: number): void;
  physics_input(world: number, length: number): number;
  physics_output(world: number): number;
  physics_intern(world: number): number;
  physics_check_queue(world: number): number;
  physics_queue_add_body(world: number): number;
  physics_queue_remove_body(world: number, key: number): number;
  physics_queue_add_constraint(world: number): number;
  physics_queue_remove_constraint(world: number, key: number): number;
  physics_queue_push(world: number, impulse: number, key: number, x: number, y: number): number;
  physics_can_add_bodies(world: number, count: number): number;
  physics_commit(world: number): number;
  physics_has_constraint(world: number, key: number): number;
  physics_generation(world: number, key: number): number;
  physics_set_motor(world: number, key: number, x: number, y: number, accel: number): number;
  physics_set_damping(world: number, key: number, linear: number, angular: number): number;
  physics_set_transform(world: number, key: number, x: number, y: number, angle: number): number;
  physics_transform(world: number, key: number): number;
  physics_overlaps_prop(world: number, r: number, x: number, y: number): number;
  physics_overlaps_dynamic_box(world: number, hx: number, hy: number, x: number, y: number): number;
  physics_counts(world: number): number;
  physics_prepare_statics(world: number): number;
  physics_set_floor(world: number): number;
  physics_floor_drag(world: number): number;
  physics_step(world: number, discardContacts: number): number;
  physics_drain_contacts(world: number): number;
  physics_debug_forces(world: number): number;
  physics_debug_contacts(world: number): number;
  physics_snapshot(world: number, includeStatic: number): number;
  physics_solid_props(world: number): number;
  physics_pending(world: number): number;
  physics_constraint_keys(world: number): number;
  // The tick boundary (`rust/core/src/boundary.rs`, #1234), driven by `shared/simulation/boundary.ts`.
  physics_boundary_input(world: number, length: number): number;
  physics_boundary_output(world: number): number;
  physics_sync_bodies(world: number, collision: number, gates: number): void;
  physics_sync_items(world: number, collision: number, gates: number): void;
  physics_admit_pending(world: number, index: number, gates: number): void;
  physics_place(world: number, collision: number, gates: number): void;
}

// The process's one core, bound once, as sight binds it (`shared/sight-core.ts`). Worlds are made
// synchronously after it: a room's world is made inside `createGame`, and the client's prediction
// makes a fresh world per correction.
let core: (CoreExports & PhysicsExports) | undefined;
let initialization: Promise<void> | undefined;
/** Loads the core for physics, once per process. Every world needs it first. */
export const initPhysics = (): Promise<void> =>
  initialization ??= initCore().then(loaded => { core = loaded as CoreExports & PhysicsExports; });
export const isPhysicsInitialized = (): boolean => core !== undefined;
// Start loading at import, as rapier.js did; a failure surfaces, with its message, from the first await.
initPhysics().catch(() => undefined);
// A world the game forgot to dispose is freed when it is collected.
const release = new FinalizationRegistry<number>(world => core?.physics_world_free(world));
const solidMask = STATIC_GROUP | ACTOR_GROUP | PROP_GROUP;
const packGroups = (membership: number, mask: number): number => (membership << 16) | mask;
const finite = (n: number | undefined, fallback = 0): number => {
  const value = n ?? fallback;
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MAGNITUDE)
    throw new TypeError('physics value must be finite and within representable bounds');
  return value;
};
const positive = (n: number | undefined, fallback?: number): number => {
  const value = finite(n, fallback);
  if (value <= 0) throw new RangeError('physics value must be positive');
  return value;
};
const nonnegative = (n: number | undefined, fallback = 0): number => {
  const value = finite(n, fallback);
  if (value < 0) throw new RangeError('physics value must be nonnegative');
  return value;
};
const dimension = (n: number | undefined): number => {
  const value = positive(n);
  if (value < 1e-6) throw new RangeError('physics dimension must be at least 1e-6');
  return value;
};
const mass = (n: number | undefined): number => {
  const value = positive(n, 1);
  if (value < 1e-6 || value > 1e6) throw new RangeError('physics mass must be within 1e-6..1e6');
  return value;
};
/** What a snapshot shares between frames is frozen and replaced, never edited, so frames need not copy it (#655). */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
}
const vector = (value: Point): Point => ({ x: finite(value.x), y: finite(value.y) });
const validId = (id: string): string => {
  if (typeof id !== 'string' || !id.length) throw new TypeError('physics ID must be a nonempty string');
  return id;
};
function shapeRadii(shape: BodySpec['shape']): { minimum: number; tip: number } {
  if (shape.kind === 'circle') return { minimum: shape.radius, tip: 0 };
  if (shape.kind === 'box') return { minimum: Math.min(shape.hx, shape.hy), tip: hypot(shape.hx, shape.hy) };
  return {
    minimum: Math.min(...shape.vertices.map((point, i, vertices) => {
      const next = vertices[(i + 1) % vertices.length]!;
      return Math.abs(point.x * next.y - point.y * next.x) / hypot(next.x - point.x, next.y - point.y);
    })),
    tip: Math.max(...shape.vertices.map(point => hypot(point.x, point.y))),
  };
}

function validateBody(input: BodySpec): BodySpec {
  validId(input.id);
  if (!['actor', 'prop', 'static'].includes(input.kind)) throw new TypeError('invalid body kind');
  const shape = input.shape;
  let checked: BodySpec['shape'];
  if (shape.kind === 'circle') checked = { kind: 'circle', radius: dimension(shape.radius) };
  else if (shape.kind === 'box') checked = { kind: 'box', hx: dimension(shape.hx), hy: dimension(shape.hy) };
  else if (shape.kind === 'convex') {
    if (!Array.isArray(shape.vertices) || shape.vertices.length < 3 || shape.vertices.length > 64) throw new RangeError('convex body needs 3..64 vertices');
    checked = { kind: 'convex', vertices: shape.vertices.map(vector) };
    const vertices = checked.vertices;
    const area = vertices.reduce((sum, p, i) => {
      const q = vertices[(i + 1) % vertices.length]!;
      return sum + p.x * q.y - q.x * p.y;
    }, 0);
    if (Math.abs(area) < 1e-6) throw new RangeError('convex body has zero area');
    const winding = Math.sign(area);
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!, b = vertices[(i + 1) % vertices.length]!, c = vertices[(i + 2) % vertices.length]!;
      const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const centerSide = (b.x - a.x) * -a.y - (b.y - a.y) * -a.x;
      if (turn * winding <= 1e-8 || centerSide * winding <= 1e-8)
        throw new RangeError('convex body must be strictly convex and centered around origin');
    }
  } else throw new TypeError('invalid body shape');
  const result: BodySpec = { id: input.id, kind: input.kind, shape: checked,
    x: finite(input.x), y: finite(input.y), angle: finite(input.angle),
    vx: finite(input.vx), vy: finite(input.vy), omega: finite(input.omega),
    mass: mass(input.mass), friction: nonnegative(input.friction, 0.5),
    restitution: nonnegative(input.restitution) };
  if (input.collisionProfile !== undefined) {
    if (input.collisionProfile !== 'loot' || input.kind !== 'prop')
      throw new TypeError('invalid physics collision profile');
    result.collisionProfile = input.collisionProfile;
  }
  if (input.mapGeometry !== undefined) {
    if (input.mapGeometry !== true || input.kind !== 'static') throw new TypeError('only static bodies can be map geometry');
    result.mapGeometry = true;
  }
  if (input.linearDamping !== undefined) result.linearDamping = nonnegative(input.linearDamping);
  if (input.angularDamping !== undefined) result.angularDamping = nonnegative(input.angularDamping);
  if (result.restitution! > 1) throw new RangeError('restitution must be <= 1');
  if (input.maxSpeed !== undefined) result.maxSpeed = positive(input.maxSpeed);
  if (result.kind === 'static' && (result.vx || result.vy || result.omega)) throw new RangeError('static body cannot move');
  if (result.kind !== 'static') {
    const { minimum, tip } = shapeRadii(checked);
    const speed = hypot(result.vx!, result.vy!) + Math.abs(result.omega!) * tip;
    const limit = Math.min(result.maxSpeed ?? Infinity, physicsSpeedLimit(minimum));
    if (speed > limit) throw new RangeError('initial physics speed requires swept-query-or-explicit-teleport');
  }
  return result;
}

/**
 * The row `world.rs` queues a body from, keyed `key`: one owner of the layout, for `queueAddBody` and for the
 * templates the core's own callers queue from (`shared/simulation/boundary.ts`).
 */
function bodyRow(spec: BodySpec, key: number, row: Float64Array = new Float64Array(BODY_ROW + (spec.shape.kind === 'convex' ? spec.shape.vertices.length * 2 : 0))): Float64Array {
  const shape = spec.shape;
  const vertices = shape.kind === 'convex' ? shape.vertices : [];
  const { minimum, tip } = shapeRadii(shape);
  const groups = spec.collisionProfile === 'loot' ? packGroups(LOOT_GROUP, STATIC_GROUP)
    : spec.kind === 'static' ? packGroups(STATIC_GROUP, solidMask | LOOT_GROUP)
      : spec.kind === 'actor' ? packGroups(ACTOR_GROUP, solidMask) : packGroups(PROP_GROUP, solidMask);
  row[0] = key; row[1] = KIND[spec.kind]; row[2] = spec.mapGeometry ? 1 : 0; row[3] = SHAPE[shape.kind];
  row[4] = shape.kind === 'circle' ? shape.radius : shape.kind === 'box' ? shape.hx : 0;
  row[5] = shape.kind === 'box' ? shape.hy : 0;
  row[6] = spec.x; row[7] = spec.y; row[8] = spec.angle!; row[9] = spec.vx!; row[10] = spec.vy!; row[11] = spec.omega!;
  row[12] = spec.mass!; row[13] = spec.friction!; row[14] = spec.restitution!;
  row[15] = spec.linearDamping ?? NaN; row[16] = spec.angularDamping ?? NaN; row[17] = groups;
  row[18] = spec.collisionProfile === 'loot' ? 1 : 0;
  row[19] = Math.min(spec.maxSpeed ?? Infinity, physicsSpeedLimit(minimum)); row[20] = tip;
  row[21] = vertices.length;
  vertices.forEach((point, i) => { row[BODY_ROW + 2 * i] = point.x; row[BODY_ROW + 2 * i + 1] = point.y; });
  return row;
}

/** A validated body's row with key 0, for a template the core queues from with its own key and pose. */
export function templateRow(input: BodySpec): Float64Array { return bodyRow(validateBody(input), 0); }

/** What JavaScript keeps of a committed body: the frozen objects snapshots share (#655). */
type BodyRecord = { spec: BodySpec; lifetime: object; motor?: MotorIntent };
/** `world.rs`'s refusals, with the messages world.ts threw. */
export const physicsRefusal = (code: number, id = '', a = '', b = ''): Error => {
  switch (code) {
    case -1: return new RangeError('physics command queue capacity exceeded');
    case -2: return new Error(`duplicate physics body ${id}`);
    case -3: return new RangeError('physics body capacity exceeded');
    case -4: return new Error(`unknown physics body ${id}`);
    case -5: return new Error(`duplicate physics removal ${id}`);
    case -6: return new Error(`duplicate physics constraint ${id}`);
    case -7: return new RangeError('physics constraint capacity exceeded');
    case -8: case -9: return new Error(`unknown physics constraint endpoint ${code === -8 ? a : b}`);
    case -10: case -11: return new Error(`map geometry cannot be a constraint endpoint ${code === -10 ? a : b}`);
    case -12: return new Error(`unknown physics constraint ${id}`);
    case -13: return new Error(`duplicate physics constraint removal ${id}`);
    case -14: return new Error(`unknown dynamic physics body ${id}`);
    case -15: return new RangeError('invalid convex body');
    case -16: return new Error('prepareStatics needs a world of committed static bodies only');
    default: return new Error(`physics core refusal ${code}`);
  }
};

export async function createPhysicsWorld(): Promise<PhysicsWorld> {
  return PhysicsWorld.create();
}

/** Initialize once, then synchronously allocate fresh islands without restoring solver caches. */
export async function createPhysicsWorldFactory(): Promise<() => PhysicsWorld> {
  return PhysicsWorld.factory();
}

/** One room owns one instance. Mutations are applied at a tick boundary. */
export class PhysicsWorld {
  readonly settings = Object.freeze({ engine: 'rapier2d (Rust core)', version: '0.36.1', unitsPerMetre: SCALE,
    substeps: SUBSTEPS, substepSeconds: DT, speculativeDistanceMetres: 0.6,
    exactCheckpoint: 'unsupported' as const, maxConstraints: 8,
    constraintLimitations: 'legacy native center rope; explicit bounded spring/rope has no hard length projection' });
  private core: CoreExports & PhysicsExports;
  /** The core's world: a pointer into WASM memory. */
  private native: number;
  /** The intern table: each ID's key in the core, and back. */
  private keys = new Map<string, number>();
  private ids: string[] = [];
  /** By key: the committed bodies' records, and the committed constraints' specs. */
  private records: Array<BodyRecord | undefined> = [];
  private constraintSpecs: Array<ConstraintSpec | undefined> = [];
  /** The queued additions' frozen specs, by key, until the commit that admits or drops them. */
  private pendingSpecs = new Map<number, BodySpec>();
  private pendingConstraintSpecs = new Map<number, ConstraintSpec>();
  /** Whether anything was queued since the last commit; a commit of empty queues does nothing. */
  private dirty = false;
  private disposed = false;

  static createSync(): PhysicsWorld {
    if (!core) throw new Error('the physics core must be initialized (initPhysics) before calling createSync');
    return new PhysicsWorld(core);
  }
  static async create(): Promise<PhysicsWorld> {
    await initPhysics();
    return new PhysicsWorld(core!);
  }
  static async factory(): Promise<() => PhysicsWorld> {
    await initPhysics();
    return () => new PhysicsWorld(core!);
  }
  private constructor(loaded: CoreExports & PhysicsExports) {
    this.core = loaded;
    this.native = loaded.physics_world_new() >>> 0;
    release.register(this, this.native, this);
  }

  /** A view of `length` values the core left at `pointer`, made after the call that returned it. */
  private view(pointer: number, length: number): Float64Array {
    return new Float64Array(this.core.memory.buffer, pointer >>> 0, length);
  }
  /** A view of the core's input buffer, resized to `length`. */
  private input(length: number): Float64Array {
    return this.view(this.core.physics_input(this.native, length), length);
  }
  /** A view of the output the last call left. */
  private output(length: number): Float64Array {
    return this.view(this.core.physics_output(this.native), length);
  }
  private ensure(): void { if (this.disposed) throw new Error('physics world disposed'); }
  /** The ID's key, sending its UTF-16 code units to the core the first time. */
  private intern(id: string): number {
    let key = this.keys.get(id);
    if (key === undefined) {
      const units = this.input(id.length);
      for (let i = 0; i < id.length; i++) units[i] = id.charCodeAt(i);
      key = this.core.physics_intern(this.native);
      this.keys.set(id, key); this.ids[key] = id;
    }
    return key;
  }
  private checkQueue(): void {
    const code = this.core.physics_check_queue(this.native);
    if (code < 0) throw physicsRefusal(code);
  }
  /** Whether a batch of dynamic bodies fits without partial queue admission. */
  canAddBodies(count: number): boolean {
    this.ensure();
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('physics body count must be a nonnegative integer');
    // More than the queue holds never fits; the bound also keeps the count within the core's u32.
    return count <= MAX_PENDING && this.core.physics_can_add_bodies(this.native, count) !== 0;
  }
  queueAddBody(input: BodySpec): void {
    this.ensure();
    let spec: BodySpec;
    try { spec = frozen(validateBody(input)); } catch (error) { this.checkQueue(); throw error; }
    const key = this.intern(spec.id);
    bodyRow(spec, key, this.input(BODY_ROW + (spec.shape.kind === 'convex' ? spec.shape.vertices.length * 2 : 0)));
    const code = this.core.physics_queue_add_body(this.native);
    if (code < 0) throw physicsRefusal(code, spec.id);
    this.pendingSpecs.set(key, spec);
    this.dirty = true;
  }
  queueRemoveBody(id: string): void {
    this.ensure();
    const key = typeof id === 'string' ? this.keys.get(id) : undefined;
    if (key === undefined) { this.checkQueue(); validId(id); throw physicsRefusal(-4, id); }
    const code = this.core.physics_queue_remove_body(this.native, key);
    if (code < 0) throw physicsRefusal(code, id);
    this.dirty = true;
  }
  queueAddConstraint(input: ConstraintSpec): void {
    this.ensure();
    let spec: ConstraintSpec;
    try { spec = frozen(validateConstraint(input)); } catch (error) { this.checkQueue(); throw error; }
    const key = this.intern(spec.id), a = this.intern(spec.a), b = this.intern(spec.b);
    const row = this.input(CONSTRAINT_ROW);
    row[0] = key; row[1] = a; row[2] = b;
    row[3] = spec.kind === undefined ? NaN : spec.kind === 'rope' ? 1 : 0;
    row[4] = spec.maxDistance; row[5] = spec.restLength ?? 0; row[6] = spec.stiffness ?? 0;
    row[7] = spec.damping ?? 0; row[8] = spec.maxForce ?? 0; row[9] = spec.breakDistance ?? NaN;
    row[10] = spec.anchorA?.x ?? 0; row[11] = spec.anchorA?.y ?? 0; row[12] = spec.anchorB?.x ?? 0; row[13] = spec.anchorB?.y ?? 0;
    const code = this.core.physics_queue_add_constraint(this.native);
    if (code < 0) throw physicsRefusal(code, spec.id, spec.a, spec.b);
    this.pendingConstraintSpecs.set(key, spec);
    this.dirty = true;
  }
  queueRemoveConstraint(id: string): void {
    this.ensure();
    const key = typeof id === 'string' ? this.keys.get(id) : undefined;
    if (key === undefined) { this.checkQueue(); validId(id); throw physicsRefusal(-12, id); }
    const code = this.core.physics_queue_remove_constraint(this.native, key);
    if (code < 0) throw physicsRefusal(code, id);
    this.dirty = true;
  }
  /**
   * Applies the queues in the core, in world.ts's old order, and takes its facts into the records: a removed body's
   * record goes, an added body's frozen spec becomes its record with a new lifetime, an added constraint's spec is kept.
   * A body Rapier cannot hull stops the commit: what was done before it stays done and reaches the records, and the
   * rest stays queued, as the old adapter's mid-commit throw left it.
   */
  commitMutations(): void {
    this.ensure();
    if (!this.dirty) return;
    const code = this.core.physics_commit(this.native);
    const count = this.output(1)[0]!;
    this.applyCommit(code, this.output(1 + count * 2), 0);
    if (code < 0) throw physicsRefusal(code);
  }
  /** A commit's facts (`count`, then `kind, key` pairs, at `at`) taken into the records; a commit that stopped keeps its queues. */
  private applyCommit(code: number, facts: Float64Array, at: number): void {
    const end = at + 1 + facts[at]! * 2;
    for (let i = at + 1; i < end; i += 2) {
      const kind = facts[i]!, key = facts[i + 1]!;
      if (kind === 0) this.records[key] = undefined;
      else if (kind === 1) {
        this.records[key] = { spec: this.pendingSpecs.get(key)!, lifetime: Object.freeze({}) };
        this.pendingSpecs.delete(key);
      } else this.constraintSpecs[key] = this.pendingConstraintSpecs.get(key)!;
    }
    if (code < 0) return;
    this.pendingSpecs.clear(); this.pendingConstraintSpecs.clear();
    this.dirty = false;
  }

  // The tick boundary in the core (`shared/simulation/boundary.ts`, #1234) runs rules that queue, commit and
  // teleport inside one call. These take what it reports into the records, in the order it reports them.
  /** The core and this world's handle, for a boundary call; views of its output follow the adapter's rules. */
  boundaryCall(): { core: CoreExports & PhysicsExports; world: number } { this.ensure(); return { core: this.core, world: this.native }; }
  /** The ID's key, interned the first time it is seen. */
  key(id: string): number { this.ensure(); return this.intern(validId(id)); }
  /** The ID a key was interned from. */
  idOf(key: number): string { return this.ids[key]!; }
  /** A body the core queued: its spec, validated and frozen as `queueAddBody` makes it. */
  adoptQueued(key: number, input: BodySpec): void {
    this.pendingSpecs.set(key, frozen(validateBody(input)));
    this.dirty = true;
  }
  /** A commit the core made, logged as its code, then its facts at `at`. */
  adoptCommit(code: number, facts: Float64Array, at: number): void { this.applyCommit(code, facts, at); }
  /** A teleport the core made (`setTransform`), which clears the motor. */
  adoptTeleport(key: number): void { delete this.records[key]!.motor; }
  /** After a boundary call: whether anything stays queued for the next commit. */
  adoptQueue(queued: number): void { this.dirty = queued > 0; }
  private record(id: string): BodyRecord | undefined {
    const key = this.keys.get(id);
    return key === undefined ? undefined : this.records[key];
  }
  hasBody(id: string): boolean { this.ensure(); return this.record(id) !== undefined; }
  /** Opaque admission lifetime, stable across teleports/damping; never a handle or serialized state. */
  bodyLifetime(id: string): object | undefined { this.ensure(); return this.record(validId(id))?.lifetime; }
  hasConstraint(id: string): boolean {
    this.ensure();
    const key = this.keys.get(validId(id));
    return key !== undefined && this.core.physics_has_constraint(this.native, key) !== 0;
  }
  /** Placement only; queries current colliders, including rotated props, without backend handles. */
  overlapsProp(x: number, y: number, radius: number): boolean {
    this.ensure();
    const r = dimension(radius), cx = finite(x), cy = finite(y);
    return this.core.physics_overlaps_prop(this.native, r, cx, cy) !== 0;
  }
  overlapsDynamicBox(box: { x: number; y: number; w: number; h: number }): boolean {
    this.ensure();
    const hx = dimension(box.w) / 2, hy = dimension(box.h) / 2;
    const cx = finite(box.x) + box.w / 2, cy = finite(box.y) + box.h / 2;
    return this.core.physics_overlaps_dynamic_box(this.native, hx, hy, cx, cy) !== 0;
  }
  getGeneration(id: string): number | undefined {
    this.ensure();
    const key = this.keys.get(validId(id));
    if (key === undefined) return undefined;
    const generation = this.core.physics_generation(this.native, key);
    return generation < 0 ? undefined : generation;
  }
  /** The key of a committed dynamic body, refused as world.ts's `dynamic` refused it. */
  private dynamicKey(id: string): number {
    const key = this.keys.get(validId(id)), record = key === undefined ? undefined : this.records[key];
    if (!record || record.spec.kind === 'static') throw physicsRefusal(-14, id);
    return key!;
  }
  setMotor(id: string, input: MotorIntent): void {
    this.ensure();
    const key = this.dynamicKey(id);
    const motor = frozen({ ...vector(input), accel: nonnegative(input.accel) });
    this.core.physics_set_motor(this.native, key, motor.x, motor.y, motor.accel);
    this.records[key]!.motor = motor;
  }
  setDamping(id: string, linear: number, angular: number): void {
    this.ensure();
    const nextLinear = nonnegative(linear), nextAngular = nonnegative(angular);
    const key = this.dynamicKey(id), changed = this.core.physics_set_damping(this.native, key, nextLinear, nextAngular);
    const record = this.records[key]!;
    if (changed & 1) record.spec = Object.freeze({ ...record.spec, linearDamping: nextLinear });
    if (changed & 2) record.spec = Object.freeze({ ...record.spec, angularDamping: nextAngular });
  }
  /** An explicit teleport: the core drops the body's constraints and queued pushes and renews its generation. */
  setTransform(id: string, value: Pick<Transform, 'x' | 'y' | 'angle'>): void {
    this.ensure();
    const key = this.dynamicKey(id);
    const x = finite(value.x), y = finite(value.y), angle = finite(value.angle);
    this.core.physics_set_transform(this.native, key, x, y, angle);
    delete this.records[key]!.motor;
  }
  private push(impulse: 0 | 1, id: string, input: Point): void {
    this.ensure(); this.checkQueue();
    const key = this.dynamicKey(id), value = vector(input);
    const code = this.core.physics_queue_push(this.native, impulse, key, value.x, value.y);
    if (code < 0) throw physicsRefusal(code, id);
    this.dirty = true;
  }
  queueForce(id: string, input: Point): void { this.push(0, id, input); }
  queueImpulse(id: string, input: Point): void { this.push(1, id, input); }
  getTransform(id: string): Transform | undefined {
    this.ensure();
    const key = this.keys.get(validId(id));
    if (key === undefined || !this.core.physics_transform(this.native, key)) return undefined;
    const pose = this.output(7);
    return { x: pose[0]!, y: pose[1]!, angle: pose[2]!, vx: pose[3]!, vy: pose[4]!, omega: pose[5]!, sleeping: pose[6] !== 0 };
  }
  /**
   * The floors floor drag reads (`rust/core/src/floor_drag.rs`), in the order they are tried, and the two damping
   * profiles: loot's for loot props, prop's for the others. A floor without a drag of its own passes 1.
   */
  setFloor(surfaces: ReadonlyArray<{ x: number; y: number; w: number; h: number; drag: number }>,
    loot: { linearDamping: number; angularDamping: number }, prop: { linearDamping: number; angularDamping: number }): void {
    this.ensure();
    const input = this.input(4 + surfaces.length * 5);
    input[0] = nonnegative(loot.linearDamping); input[1] = nonnegative(loot.angularDamping);
    input[2] = nonnegative(prop.linearDamping); input[3] = nonnegative(prop.angularDamping);
    // A floor stays f64 in the core, never a Rapier f32 coordinate, so any finite rectangle is accepted, as actor
    // physics' validation accepts it (review 970); only body values carry finite()'s representability bound.
    const real = (n: number): number => {
      if (!Number.isFinite(n)) throw new TypeError('floor values must be finite');
      return n;
    };
    let at = 4;
    for (const f of surfaces) {
      input[at++] = real(f.x); input[at++] = real(f.y); input[at++] = real(f.w); input[at++] = real(f.h);
      input[at++] = nonnegative(f.drag);
    }
    this.core.physics_set_floor(this.native);
  }
  /**
   * Floor drag over the committed props, run in the core; nothing until `setFloor`. Each damping the core changed is
   * written to its spec as `setDamping` writes it, linear before angular, so snapshots read the same specs.
   */
  applyFloorDrag(): void {
    this.ensure();
    const count = this.core.physics_floor_drag(this.native);
    if (!count) return;
    const rows = this.output(count * DRAG_STRIDE);
    for (let offset = 0; offset < rows.length; offset += DRAG_STRIDE) {
      const record = this.records[rows[offset]!]!, changed = rows[offset + 1]!;
      if (changed & 1) record.spec = Object.freeze({ ...record.spec, linearDamping: rows[offset + 2]! });
      if (changed & 2) record.spec = Object.freeze({ ...record.spec, angularDamping: rows[offset + 3]! });
    }
  }
  /**
   * One tick. `discardContacts` is for a caller that would drain and drop them at once, as the game's tick does: no
   * contact records are built, but the retained-fact capacity is enforced as if they were, and none are kept.
   */
  step(options: { discardContacts?: boolean } = {}): { distance: Record<string, number>; paths: Record<string, Point[]> } {
    this.ensure(); this.commitMutations();
    const pointer = this.core.physics_step(this.native, options.discardContacts ? 1 : 0) >>> 0;
    const header = this.view(pointer, STEP_HEADER);
    const status = header[0]!, failed = header[1]!, count = header[2]!, dropped = header[3]!;
    // A failed step's output is its header alone.
    if (status === 1) throw new Error(`nonfinite physics speed ${this.ids[failed]}`);
    if (status === 2) throw new Error(`nonfinite physics angular speed ${this.ids[failed]}`);
    const output = this.view(pointer, STEP_HEADER + count + (SUBSTEPS + 1) * count * 2);

    const distance: Record<string, number> = Object.create(null);
    const paths: Record<string, Point[]> = Object.create(null);
    const base = STEP_HEADER + count;
    for (let i = 0; i < count; i++) {
      const id = this.ids[output[STEP_HEADER + i]!]!;
      let x = output[base + 2 * i]!, y = output[base + 2 * i + 1]!, travelled = 0;
      const path = [{ x, y }];
      for (let substep = 1; substep <= SUBSTEPS; substep++) {
        const offset = base + (substep * count + i) * 2;
        const nx = output[offset]!, ny = output[offset + 1]!;
        travelled += hypot(nx - x, ny - y);
        path.push({ x: nx, y: ny });
        x = nx; y = ny;
      }
      distance[id] = travelled; paths[id] = path;
    }
    if (dropped) throw new RangeError(`physics event capacity exceeded (${dropped} events over ${MAX_EVENTS})`);
    return { distance, paths };
  }
  /**
   * One native step while the world holds only committed static bodies (#1087): it builds the broad phase over the
   * map's colliders before any body that moves exists, so that work leaves the first gameplay tick. Nothing can move,
   * touch or wake, so it reports nothing and changes no gameplay state; it refuses any other world.
   */
  prepareStatics(): void {
    this.ensure();
    const events = this.core.physics_prepare_statics(this.native);
    if (events < 0) throw physicsRefusal(events);
    if (events) throw new Error(`prepareStatics produced ${events} native events`);
  }
  drainContacts(): PhysicsContact[] {
    this.ensure();
    const count = this.core.physics_drain_contacts(this.native), rows = this.output(count * EVENT_STRIDE);
    const contacts: PhysicsContact[] = [];
    for (let offset = 0; offset < rows.length; offset += EVENT_STRIDE) {
      contacts.push({ a: this.ids[rows[offset + 1]!]!, b: this.ids[rows[offset + 2]!]!, substep: rows[offset]!,
        type: rows[offset + 3] ? 'start' : 'stop' });
    }
    return contacts;
  }
  /** Final-substep external force accumulators, excluding motor velocity changes
   * and collision impulses. Developer-only; no extra work during ordinary ticks. */
  debugForces(): Array<{ id: string; point: Point; force: Point }> {
    this.ensure();
    const count = this.core.physics_debug_forces(this.native), rows = this.output(count * FORCE_STRIDE);
    const result: Array<{ id: string; point: Point; force: Point }> = [];
    for (let offset = 0; offset < rows.length; offset += FORCE_STRIDE) {
      result.push({ id: this.ids[rows[offset]!]!, point: { x: rows[offset + 1]!, y: rows[offset + 2]! },
        force: { x: rows[offset + 3]!, y: rows[offset + 4]! } });
    }
    return result;
  }
  /** Private developer diagnostic, sampled on demand after the final substep: each touching pair's manifold
   * points, on the first collider's surface, with the normal from `a` to `b`. Never include this in a gameplay
   * snapshot or a player projection. The core names, orders and caps them. */
  debugContacts(): Array<{ a: string; b: string; point: Point; normal: Point; distance: number }> {
    this.ensure();
    const count = this.core.physics_debug_contacts(this.native), rows = this.output(count * CONTACT_STRIDE);
    const result: Array<{ a: string; b: string; point: Point; normal: Point; distance: number }> = [];
    for (let offset = 0; offset < rows.length; offset += CONTACT_STRIDE) {
      result.push({ a: this.ids[rows[offset]!]!, b: this.ids[rows[offset + 1]!]!,
        point: { x: rows[offset + 2]!, y: rows[offset + 3]! },
        normal: { x: rows[offset + 4]!, y: rows[offset + 5]! }, distance: rows[offset + 6]! });
    }
    return result;
  }
  counts(): { actors: number; dynamic: number; static: number; constraints: number } {
    this.ensure();
    this.core.physics_counts(this.native);
    const value = this.output(4);
    return { actors: value[0]!, dynamic: value[1]!, static: value[2]!, constraints: value[3]! };
  }
  /** Rows of `key, generation, pose`, read into records before the next core call. */
  private bodyRows(count: number): Array<{ key: number; generation: number; transform: Transform }> {
    const rows = this.output(count * SNAPSHOT_STRIDE), result = [];
    for (let offset = 0; offset < rows.length; offset += SNAPSHOT_STRIDE) {
      result.push({ key: rows[offset]!, generation: rows[offset + 1]!, transform: { x: rows[offset + 2]!, y: rows[offset + 3]!,
        angle: rows[offset + 4]!, vx: rows[offset + 5]!, vy: rows[offset + 6]!, omega: rows[offset + 7]!, sleeping: rows[offset + 8] !== 0 } });
    }
    return result;
  }
  /** Lists and transforms are the caller's own; specs, motors and queued entries are frozen and shared with the world. */
  snapshot(options: { includeStatic?: boolean; includePending: false }): Omit<PhysicsSnapshot, 'pending'>;
  snapshot(options?: { includeStatic?: boolean; includePending?: true }): PhysicsSnapshot;
  snapshot(options: { includeStatic?: boolean; includePending?: boolean } = {}): PhysicsSnapshot | Omit<PhysicsSnapshot, 'pending'> {
    this.ensure();
    const bodies = this.bodyRows(this.core.physics_snapshot(this.native, options.includeStatic === false ? 0 : 1))
      .map(({ key, generation, transform }) => {
        const record = this.records[key]!;
        return { spec: record.spec, transform, generation, ...(record.motor ? { motor: record.motor } : {}) };
      });
    const constraintCount = this.core.physics_constraint_keys(this.native);
    const constraints = Array.from(this.output(constraintCount), key => this.constraintSpecs[key]!);
    const base = { bodies, constraints };
    if (options.includePending === false) return base;
    this.core.physics_pending(this.native);
    const counts = this.output(6);
    const [add, remove, addConstraints, removeConstraints, forces, impulses] = Array.from(counts);
    const keys = add! + remove! + addConstraints! + removeConstraints!;
    const all = this.output(6 + keys + (forces! + impulses!) * 3);
    let at = 6;
    const next = (n: number): number[] => Array.from(all.subarray(at, at += n));
    const pushes = (n: number) => Array.from({ length: n }, () => {
      const [key, x, y] = next(3);
      return frozen({ id: this.ids[key!]!, value: { x: x!, y: y! } });
    });
    return {
      ...base,
      pending: { add: next(add!).map(key => this.pendingSpecs.get(key)!), remove: next(remove!).map(key => this.ids[key]!),
        addConstraints: next(addConstraints!).map(key => this.pendingConstraintSpecs.get(key)!),
        removeConstraints: next(removeConstraints!).map(key => this.ids[key]!),
        forces: pushes(forces!), impulses: pushes(impulses!) },
    };
  }
  /** Small query view for local navigation: excludes loot, actors and pending/constraint state. Specs are shared, frozen. */
  solidPropStates(): Array<{ spec: BodySpec; transform: Transform }> {
    this.ensure();
    return this.bodyRows(this.core.physics_solid_props(this.native))
      .map(({ key, transform }) => ({ spec: this.records[key]!.spec, transform }));
  }
  dispose(): void {
    if (this.disposed) return;
    release.unregister(this);
    this.core.physics_world_free(this.native);
    this.keys.clear(); this.ids = []; this.records = []; this.constraintSpecs = [];
    this.pendingSpecs.clear(); this.pendingConstraintSpecs.clear();
    this.disposed = true;
  }
}
