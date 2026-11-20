import { PHYSICS_SUBSTEP_SECONDS, physicsSpeedLimit } from './motion-limits.ts';
import { validateConstraint } from './constraints.ts';
import { UNITS_PER_METRE } from './units.ts';
import type { BodySpec, ConstraintSpec, MotorIntent, PhysicsContact, PhysicsSnapshot, Point, Transform } from './types.ts';
import { initCore, type CoreExports } from '../core.ts';
import { hypot } from '../math.ts';

// The adapter between the game's queue-and-commit physics interface and Rapier, which is compiled
// into the Rust core (`rust/core/src/physics.rs`, #1192, docs/27). This file keeps what is not the
// engine: validation, the command queues, IDs, generations, the commit order and every ordering by
// ID. The core holds Rapier's sets and runs each tick's four substeps in one call, with the motors,
// forces, impulses, bounded constraints and speed caps this file used to apply between rapier.js
// calls. The adapter rules are 27's:
// - **Flat buffers.** A step's input is one `Float64Array` written into a buffer the core owns; its
//   output is read through a view of another.
// - **Views are made after each call,** because any allocation may grow WASM memory and detach the
//   old `memory.buffer`.
// - **Pointers are read with `>>> 0`,** since WASM returns them as signed 32-bit integers.

// World units per Rapier metre, the adapter's short name for units.ts's UNITS_PER_METRE.
const SCALE = UNITS_PER_METRE;
const SUBSTEPS = 4;
const DT = PHYSICS_SUBSTEP_SECONDS;
const MAX_DYNAMIC = 128;
const MAX_ACTORS = 27;
const MAX_STATIC = 100000;
const MAX_PENDING = 1024;
const MAX_EVENTS = 8192;
// Keep inputs representable through world-unit conversion and the f32 backend.
// This is an admission guard, not a promise of useful precision at this extent.
const MAX_MAGNITUDE = 1e9;
const STATIC_GROUP = 0x0001;
const ACTOR_GROUP = 0x0002;
const PROP_GROUP = 0x0004;
const LOOT_GROUP = 0x0008;
// The core's encodings and row widths (`rust/core/src/physics.rs`).
const KIND = { static: 0, actor: 1, prop: 2 } as const;
const SHAPE = { circle: 0, box: 1, convex: 2 } as const;
const DYNAMIC_STRIDE = 7, PUSH_STRIDE = 3, CONSTRAINT_STRIDE = 13, EVENT_STRIDE = 4, HEADER = 4, CONTACT_STRIDE = 7;

/** The core's physics exports (`rust/core/src/lib.rs`). A world and every pointer are numbers. */
export interface PhysicsExports {
  physics_world_new(): number;
  physics_world_free(world: number): void;
  physics_add_body(world: number, kind: number, mapGeometry: number, shape: number, a: number, b: number,
    vertices: number, vertexCount: number, x: number, y: number, angle: number, vx: number, vy: number, omega: number,
    mass: number, friction: number, restitution: number, linearDamping: number, angularDamping: number, groups: number): number;
  physics_remove_body(world: number, slot: number): void;
  physics_wake(world: number, slot: number): void;
  physics_add_rope(world: number, a: number, b: number, maxDistance: number): number;
  physics_remove_rope(world: number, rope: number): void;
  physics_set_damping(world: number, slot: number, angular: number, value: number): void;
  physics_set_pose(world: number, slot: number, x: number, y: number, angle: number): void;
  physics_pose(world: number, slot: number): number;
  physics_user_force(world: number, slot: number): number;
  physics_propagate(world: number): void;
  physics_intersects(world: number, slot: number, shape: number, a: number, b: number, x: number, y: number): number;
  physics_prepare(world: number): number;
  physics_input(world: number, length: number): number;
  physics_step(world: number, dynamics: number, forces: number, impulses: number, constraints: number): number;
  physics_debug_contacts(world: number): number;
  physics_output(world: number): number;
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
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
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

type RecordBody = { spec: BodySpec; slot: number; generation: number; lifetime: object;
  motor?: MotorIntent; minimumRadius: number; tipRadius: number };

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
  private bodies = new Map<string, RecordBody>();
  private sortedDynamic: Array<[string, RecordBody]> = [];
  private actorCount = 0;
  private dynamicCount = 0;
  private staticCount = 0;
  private nextGeneration = 0;
  /** Each live slot's body ID; events and debug contacts name slots. */
  private slotIds: Array<string | undefined> = [];
  private constraints = new Map<string, { spec: ConstraintSpec; rope?: number }>();
  private pendingAdd: BodySpec[] = [];
  private pendingRemove: string[] = [];
  private pendingAddConstraints: ConstraintSpec[] = [];
  private pendingRemoveConstraints: string[] = [];
  private forces: Array<{ id: string; value: Point }> = [];
  private impulses: Array<{ id: string; value: Point }> = [];
  private contacts: PhysicsContact[] = [];
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
  private ensure(): void { if (this.disposed) throw new Error('physics world disposed'); }
  private roomCount(kind: BodySpec['kind']): number {
    return (kind === 'actor' ? this.actorCount : kind === 'static' ? this.staticCount : this.dynamicCount - this.actorCount)
      + this.pendingAdd.filter(spec => spec.kind === kind).length
      - this.pendingRemove.filter(id => this.bodies.get(id)?.spec.kind === kind).length;
  }
  private checkQueue(): void {
    if (this.pendingAdd.length + this.pendingRemove.length + this.pendingAddConstraints.length +
        this.pendingRemoveConstraints.length + this.forces.length + this.impulses.length >= MAX_PENDING)
      throw new RangeError('physics command queue capacity exceeded');
  }
  /** Whether a batch of dynamic bodies fits without partial queue admission. */
  canAddBodies(count: number): boolean {
    this.ensure();
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('physics body count must be a nonnegative integer');
    const queued = this.pendingAdd.length + this.pendingRemove.length + this.pendingAddConstraints.length +
      this.pendingRemoveConstraints.length + this.forces.length + this.impulses.length;
    return count <= MAX_DYNAMIC - this.roomCount('actor') - this.roomCount('prop') &&
      count <= MAX_PENDING - queued;
  }
  queueAddBody(input: BodySpec): void {
    this.ensure(); this.checkQueue();
    const spec = frozen(validateBody(input));
    if (this.bodies.has(spec.id) && !this.pendingRemove.includes(spec.id) || this.pendingAdd.some(body => body.id === spec.id))
      throw new Error(`duplicate physics body ${spec.id}`);
    const dynamic = this.roomCount('actor') + this.roomCount('prop');
    if (spec.kind === 'actor' && this.roomCount('actor') >= MAX_ACTORS ||
        spec.kind !== 'static' && dynamic >= MAX_DYNAMIC ||
        spec.kind === 'static' && this.roomCount('static') >= MAX_STATIC)
      throw new RangeError('physics body capacity exceeded');
    this.pendingAdd.push(spec);
  }
  queueRemoveBody(id: string): void {
    this.ensure(); this.checkQueue(); validId(id);
    if (!this.bodies.has(id) && !this.pendingAdd.some(body => body.id === id)) throw new Error(`unknown physics body ${id}`);
    if (this.pendingRemove.includes(id)) throw new Error(`duplicate physics removal ${id}`);
    this.pendingRemove.push(id);
  }
  queueAddConstraint(input: ConstraintSpec): void {
    this.ensure(); this.checkQueue();
    const spec = frozen(validateConstraint(input));
    if (this.constraints.has(spec.id) && !this.pendingRemoveConstraints.includes(spec.id) ||
        this.pendingAddConstraints.some(item => item.id === spec.id)) throw new Error(`duplicate physics constraint ${spec.id}`);
    if (this.constraints.size - this.pendingRemoveConstraints.length + this.pendingAddConstraints.length >= 8)
      throw new RangeError('physics constraint capacity exceeded');
    for (const id of [spec.a, spec.b]) {
      if ((!this.bodies.has(id) || this.pendingRemove.includes(id)) && !this.pendingAdd.some(body => body.id === id))
        throw new Error(`unknown physics constraint endpoint ${id}`);
      if ((this.bodies.get(id)?.spec ?? this.pendingAdd.find(body => body.id === id))?.mapGeometry)
        throw new Error(`map geometry cannot be a constraint endpoint ${id}`);
    }
    this.pendingAddConstraints.push(spec);
  }
  queueRemoveConstraint(id: string): void {
    this.ensure(); this.checkQueue(); validId(id);
    if (!this.constraints.has(id) && !this.pendingAddConstraints.some(item => item.id === id))
      throw new Error(`unknown physics constraint ${id}`);
    if (this.pendingRemoveConstraints.includes(id)) throw new Error(`duplicate physics constraint removal ${id}`);
    this.pendingRemoveConstraints.push(id);
  }
  private add(spec: BodySpec): void {
    // Map geometry's colliders all hang off one fixed body, placed by their own translation: Rapier's step costs
    // per fixed body as well as per collider, and the frames are the same (42.22 "Static colliders and the solve").
    const { minimum: minimumRadius, tip: tipRadius } = shapeRadii(spec.shape);
    const groups = spec.collisionProfile === 'loot' ? packGroups(LOOT_GROUP, STATIC_GROUP)
      : spec.kind === 'static' ? packGroups(STATIC_GROUP, solidMask | LOOT_GROUP)
        : spec.kind === 'actor' ? packGroups(ACTOR_GROUP, solidMask) : packGroups(PROP_GROUP, solidMask);
    const shape = spec.shape;
    const a = shape.kind === 'circle' ? shape.radius : shape.kind === 'box' ? shape.hx : 0;
    const b = shape.kind === 'box' ? shape.hy : 0;
    const add = (vertices: number, vertexCount: number) => this.core.physics_add_body(this.native, KIND[spec.kind],
      spec.mapGeometry ? 1 : 0, SHAPE[shape.kind], a, b, vertices, vertexCount,
      spec.x, spec.y, spec.angle!, spec.vx!, spec.vy!, spec.omega!, spec.mass!, spec.friction!, spec.restitution!,
      spec.linearDamping ?? NaN, spec.angularDamping ?? NaN, groups);
    let slot: number;
    if (shape.kind === 'convex') {
      const bytes = shape.vertices.length * 16, pointer = this.core.core_alloc(bytes) >>> 0;
      try {
        const vertices = new Float64Array(this.core.memory.buffer, pointer, shape.vertices.length * 2);
        shape.vertices.forEach((point, i) => { vertices[2 * i] = point.x; vertices[2 * i + 1] = point.y; });
        slot = add(pointer, shape.vertices.length);
      } finally { this.core.core_free(pointer, bytes); }
    } else slot = add(0, 0);
    if (slot < 0) throw new RangeError('invalid convex body');
    this.bodies.set(spec.id, { spec, slot, lifetime: Object.freeze({}),
      generation: ++this.nextGeneration, minimumRadius, tipRadius });
    if (spec.kind === 'static') this.staticCount++;
    else { this.dynamicCount++; if (spec.kind === 'actor') this.actorCount++; }
    this.slotIds[slot] = spec.id;
  }
  private wakeConstraintEndpoints(spec: ConstraintSpec): void {
    for (const id of [spec.a, spec.b]) {
      const record = this.bodies.get(id);
      if (record && record.spec.kind !== 'static') this.core.physics_wake(this.native, record.slot);
    }
  }
  /** Drops a constraint: a native rope leaves the core, waking its bodies; a bounded one wakes them here. */
  private dropConstraint(id: string, record: { spec: ConstraintSpec; rope?: number }): void {
    if (record.rope !== undefined) this.core.physics_remove_rope(this.native, record.rope);
    else this.wakeConstraintEndpoints(record.spec);
    this.constraints.delete(id);
  }
  commitMutations(): void {
    this.ensure();
    const bodiesChanged = this.pendingAdd.length > 0 || this.pendingRemove.length > 0;
    const removed = new Set(this.pendingRemove);
    const existingBeforeRemoval = new Set(this.pendingRemove.filter(id => this.bodies.has(id)));
    for (const id of this.pendingRemoveConstraints.sort(order)) {
      const record = this.constraints.get(id);
      if (record) this.dropConstraint(id, record);
    }
    for (const id of this.pendingRemove.sort(order)) {
      const record = this.bodies.get(id);
      if (record) {
        for (const [jointId, joint] of this.constraints) {
          if (joint.spec.a === id || joint.spec.b === id) {
            // Rapier removes a body's joints with it; only the rope's index is released here.
            if (joint.rope === undefined) this.wakeConstraintEndpoints(joint.spec);
            this.constraints.delete(jointId);
          }
        }
        this.core.physics_remove_body(this.native, record.slot);
        this.slotIds[record.slot] = undefined;
        this.bodies.delete(id);
        if (record.spec.kind === 'static') this.staticCount--;
        else { this.dynamicCount--; if (record.spec.kind === 'actor') this.actorCount--; }
      }
    }
    for (const spec of this.pendingAdd.sort((a, b) => order(a.id, b.id))) {
      // A create/remove pair cancels before admission. Removing an existing ID
      // and re-adding it is a replacement with a new private engine handle.
      if (!removed.has(spec.id) || existingBeforeRemoval.has(spec.id)) this.add(spec);
    }
    for (const spec of this.pendingAddConstraints.sort((a, b) => order(a.id, b.id))) {
      if (this.pendingRemoveConstraints.includes(spec.id) ||
          this.pendingRemove.includes(spec.a) || this.pendingRemove.includes(spec.b)) continue;
      const a = this.bodies.get(spec.a), b = this.bodies.get(spec.b);
      if (!a || !b) continue;
      if (spec.kind === undefined) {
        this.constraints.set(spec.id, { spec, rope: this.core.physics_add_rope(this.native, a.slot, b.slot, spec.maxDistance) });
      } else {
        this.constraints.set(spec.id, { spec });
        this.core.physics_wake(this.native, a.slot);
        this.core.physics_wake(this.native, b.slot);
      }
    }
    if (bodiesChanged) {
      // Item drops commit one body at a time. Reuse the bounded dynamic list instead of
      // scanning every map collider for each addition; native mutation order stays above.
      this.sortedDynamic = this.sortedDynamic.filter(([id]) => !removed.has(id));
      for (const spec of this.pendingAdd) {
        if (spec.kind === 'static') continue;
        const record = this.bodies.get(spec.id);
        if (record) this.sortedDynamic.push([spec.id, record]);
      }
      this.sortedDynamic.sort(([a], [b]) => order(a, b));
    }
    this.pendingRemove = []; this.pendingAdd = [];
    this.pendingRemoveConstraints = []; this.pendingAddConstraints = [];
    this.forces = this.forces.filter(entry => !removed.has(entry.id));
    this.impulses = this.impulses.filter(entry => !removed.has(entry.id));
  }
  hasBody(id: string): boolean { this.ensure(); return this.bodies.has(id); }
  /** Opaque admission lifetime, stable across teleports/damping; never a handle or serialized state. */
  bodyLifetime(id: string): object | undefined { this.ensure(); return this.bodies.get(validId(id))?.lifetime; }
  hasConstraint(id: string): boolean { this.ensure(); return this.constraints.has(validId(id)); }
  /** Placement only; queries current colliders, including rotated props, without backend handles. */
  overlapsProp(x: number, y: number, radius: number): boolean {
    this.ensure();
    const r = dimension(radius), cx = finite(x), cy = finite(y);
    this.core.physics_propagate(this.native);
    return this.sortedDynamic.some(([, record]) => record.spec.kind === 'prop' && record.spec.collisionProfile !== 'loot'
      && this.core.physics_intersects(this.native, record.slot, SHAPE.circle, r, 0, cx, cy) !== 0);
  }
  overlapsDynamicBox(box: { x: number; y: number; w: number; h: number }): boolean {
    this.ensure();
    const hx = dimension(box.w) / 2, hy = dimension(box.h) / 2;
    const cx = finite(box.x) + box.w / 2, cy = finite(box.y) + box.h / 2;
    this.core.physics_propagate(this.native);
    return this.sortedDynamic.some(([, record]) => record.spec.collisionProfile !== 'loot'
      && this.core.physics_intersects(this.native, record.slot, SHAPE.box, hx, hy, cx, cy) !== 0);
  }
  getGeneration(id: string): number | undefined {
    this.ensure(); return this.bodies.get(validId(id))?.generation;
  }
  private dynamic(id: string): RecordBody {
    const record = this.bodies.get(validId(id));
    if (!record || record.spec.kind === 'static') throw new Error(`unknown dynamic physics body ${id}`);
    return record;
  }
  setMotor(id: string, input: MotorIntent): void {
    this.ensure(); const record = this.dynamic(id);
    record.motor = frozen({ ...vector(input), accel: nonnegative(input.accel) });
    this.core.physics_wake(this.native, record.slot);
  }
  setDamping(id: string, linear: number, angular: number): void {
    this.ensure();
    const nextLinear = nonnegative(linear), nextAngular = nonnegative(angular);
    const record = this.dynamic(id);
    if ((record.spec.linearDamping ?? 0) !== nextLinear) {
      this.core.physics_set_damping(this.native, record.slot, 0, nextLinear);
      record.spec = Object.freeze({ ...record.spec, linearDamping: nextLinear });
    }
    if ((record.spec.angularDamping ?? 0) !== nextAngular) {
      this.core.physics_set_damping(this.native, record.slot, 1, nextAngular);
      record.spec = Object.freeze({ ...record.spec, angularDamping: nextAngular });
    }
  }
  setTransform(id: string, value: Pick<Transform, 'x' | 'y' | 'angle'>): void {
    this.ensure(); const record = this.dynamic(id);
    const x = finite(value.x), y = finite(value.y), angle = finite(value.angle);
    for (const [jointId, joint] of this.constraints) {
      if (joint.spec.a !== id && joint.spec.b !== id) continue;
      this.dropConstraint(jointId, joint);
    }
    this.pendingAddConstraints = this.pendingAddConstraints.filter(spec => spec.a !== id && spec.b !== id);
    this.pendingRemoveConstraints = this.pendingRemoveConstraints.filter(jointId =>
      this.constraints.has(jointId) || this.pendingAddConstraints.some(spec => spec.id === jointId));
    this.forces = this.forces.filter(entry => entry.id !== id);
    this.impulses = this.impulses.filter(entry => entry.id !== id);
    delete record.motor;
    record.generation = ++this.nextGeneration;
    this.core.physics_set_pose(this.native, record.slot, x, y, angle);
  }
  queueForce(id: string, input: Point): void {
    this.ensure(); this.checkQueue(); this.dynamic(id);
    this.forces.push(frozen({ id, value: vector(input) }));
  }
  queueImpulse(id: string, input: Point): void {
    this.ensure(); this.checkQueue(); this.dynamic(id);
    this.impulses.push(frozen({ id, value: vector(input) }));
  }
  getTransform(id: string): Transform | undefined {
    this.ensure(); const record = this.bodies.get(validId(id));
    if (!record) return undefined;
    const pose = this.view(this.core.physics_pose(this.native, record.slot), 7);
    return { x: pose[0]!, y: pose[1]!, angle: pose[2]!, vx: pose[3]!, vy: pose[4]!, omega: pose[5]!, sleeping: pose[6] !== 0 };
  }
  step(): { distance: Record<string, number>; paths: Record<string, Point[]> } {
    this.ensure(); this.commitMutations();
    const dynamics = this.sortedDynamic;
    const forces = this.forces.sort((a, b) => order(a.id, b.id)).filter(entry => this.bodies.has(entry.id));
    const impulses = this.impulses.sort((a, b) => order(a.id, b.id)).filter(entry => this.bodies.has(entry.id));
    this.forces = []; this.impulses = [];
    const bounded: Array<[string, ConstraintSpec, RecordBody, RecordBody]> = [];
    for (const [id, record] of [...this.constraints].sort(([a], [b]) => order(a, b))) {
      if (record.spec.kind === undefined) continue;
      const first = this.bodies.get(record.spec.a), second = this.bodies.get(record.spec.b);
      if (!first || !second) { this.constraints.delete(id); continue; }
      bounded.push([id, record.spec, first, second]);
    }

    // One input buffer: dynamic bodies with their motors and speed caps, forces, impulses, constraints.
    const length = dynamics.length * DYNAMIC_STRIDE + (forces.length + impulses.length) * PUSH_STRIDE + bounded.length * CONSTRAINT_STRIDE;
    const input = this.view(this.core.physics_input(this.native, length), length);
    let at = 0;
    for (const [, record] of dynamics) {
      const motor = record.motor;
      input[at++] = record.slot; input[at++] = motor ? 1 : 0;
      input[at++] = motor?.x ?? 0; input[at++] = motor?.y ?? 0; input[at++] = motor?.accel ?? 0;
      input[at++] = Math.min(record.spec.maxSpeed ?? Infinity, physicsSpeedLimit(record.minimumRadius));
      input[at++] = record.tipRadius;
    }
    for (const entry of [...forces, ...impulses]) {
      input[at++] = this.bodies.get(entry.id)!.slot; input[at++] = entry.value.x; input[at++] = entry.value.y;
    }
    for (const [, spec, first, second] of bounded) {
      input[at++] = first.slot; input[at++] = second.slot; input[at++] = spec.kind === 'rope' ? 1 : 0;
      input[at++] = spec.maxDistance; input[at++] = spec.restLength ?? 0; input[at++] = spec.stiffness!;
      input[at++] = spec.damping!; input[at++] = spec.maxForce!; input[at++] = spec.breakDistance ?? NaN;
      input[at++] = spec.anchorA!.x; input[at++] = spec.anchorA!.y; input[at++] = spec.anchorB!.x; input[at++] = spec.anchorB!.y;
    }

    const pointer = this.core.physics_step(this.native, dynamics.length, forces.length, impulses.length, bounded.length) >>> 0;
    const header = this.view(pointer, HEADER);
    const status = header[0]!, failed = header[1]!, eventCount = header[2]!, brokenCount = header[3]!;
    const positionLength = (SUBSTEPS + 1) * dynamics.length * 2;
    const output = this.view(pointer, HEADER + positionLength + eventCount * EVENT_STRIDE + brokenCount);
    if (status === 1) throw new Error(`nonfinite physics speed ${dynamics[failed]![0]}`);
    if (status === 2) throw new Error(`nonfinite physics angular speed ${dynamics[failed]![0]}`);

    const distance: Record<string, number> = Object.create(null);
    const paths: Record<string, Point[]> = Object.create(null);
    dynamics.forEach(([id], i) => {
      let x = output[HEADER + 2 * i]!, y = output[HEADER + 2 * i + 1]!, travelled = 0;
      const path = [{ x, y }];
      for (let substep = 1; substep <= SUBSTEPS; substep++) {
        const offset = HEADER + (substep * dynamics.length + i) * 2;
        const nx = output[offset]!, ny = output[offset + 1]!;
        travelled += hypot(nx - x, ny - y);
        path.push({ x: nx, y: ny });
        x = nx; y = ny;
      }
      distance[id] = travelled; paths[id] = path;
    });
    let dropped = 0;
    for (let e = 0, offset = HEADER + positionLength; e < eventCount; e++, offset += EVENT_STRIDE) {
      const first = this.slotIds[output[offset + 1]!], second = this.slotIds[output[offset + 2]!];
      if (!first || !second) continue;
      if (this.contacts.length >= MAX_EVENTS) { dropped++; continue; }
      this.contacts.push({ a: order(first, second) <= 0 ? first : second,
        b: order(first, second) <= 0 ? second : first, substep: output[offset]!, type: output[offset + 3] ? 'start' : 'stop' });
    }
    for (let i = 0, offset = HEADER + positionLength + eventCount * EVENT_STRIDE; i < brokenCount; i++)
      this.constraints.delete(bounded[output[offset + i]!]![0]);
    if (dropped) throw new RangeError(`physics event capacity exceeded (${dropped} events over ${MAX_EVENTS})`);
    this.contacts.sort((a, b) => a.substep - b.substep || order(a.a, b.a) || order(a.b, b.b) || order(a.type, b.type));
    return { distance, paths };
  }
  /**
   * One native step while the world holds only committed static bodies (#1087): it builds the broad phase over the
   * map's colliders before any body that moves exists, so that work leaves the first gameplay tick. Nothing can move,
   * touch or wake, so it reports nothing and changes no gameplay state; it refuses any other world.
   */
  prepareStatics(): void {
    this.ensure();
    if (this.dynamicCount !== 0 || this.constraints.size !== 0 || this.pendingAdd.length + this.pendingRemove.length
      + this.pendingAddConstraints.length + this.pendingRemoveConstraints.length + this.forces.length + this.impulses.length !== 0) {
      throw new Error('prepareStatics needs a world of committed static bodies only');
    }
    const events = this.core.physics_prepare(this.native);
    if (events) throw new Error(`prepareStatics produced ${events} native events`);
  }
  drainContacts(): PhysicsContact[] { this.ensure(); return this.contacts.splice(0); }
  /** Final-substep external force accumulators, excluding motor velocity changes
   * and collision impulses. Developer-only; no extra work during ordinary ticks. */
  debugForces(): Array<{ id: string; point: Point; force: Point }> {
    this.ensure();
    return this.sortedDynamic.map(([id, record]) => {
      const value = this.view(this.core.physics_user_force(this.native, record.slot), 4);
      return { id, point: { x: value[0]!, y: value[1]! }, force: { x: value[2]!, y: value[3]! } };
    });
  }
  /** Private developer diagnostic, sampled on demand after the final substep: each touching pair's manifold
   * points, on the first collider's surface, with the normal from `a` to `b`. Never include this in a gameplay
   * snapshot or a player projection. */
  debugContacts(): Array<{ a: string; b: string; point: Point; normal: Point; distance: number }> {
    this.ensure();
    const count = this.core.physics_debug_contacts(this.native);
    const rows = this.view(this.core.physics_output(this.native), count * CONTACT_STRIDE);
    const result: Array<{ a: string; b: string; point: Point; normal: Point; distance: number }> = [];
    for (let offset = 0; offset < rows.length; offset += CONTACT_STRIDE) {
      const first = this.slotIds[rows[offset]!], second = this.slotIds[rows[offset + 1]!];
      if (!first || !second) continue;
      const sign = order(first, second) <= 0 ? 1 : -1;
      result.push({ a: sign > 0 ? first : second, b: sign > 0 ? second : first,
        point: { x: rows[offset + 2]!, y: rows[offset + 3]! },
        normal: { x: rows[offset + 4]! * sign, y: rows[offset + 5]! * sign }, distance: rows[offset + 6]! });
    }
    return result.sort((a, b) => order(a.a, b.a) || order(a.b, b.b)
      || a.point.x - b.point.x || a.point.y - b.point.y).slice(0, 256);
  }
  counts(): { actors: number; dynamic: number; static: number; constraints: number } {
    this.ensure();
    return { actors: this.actorCount, dynamic: this.dynamicCount, static: this.staticCount, constraints: this.constraints.size };
  }
  /** Lists and transforms are the caller's own; specs, motors and queued entries are frozen and shared with the world. */
  snapshot(options: { includeStatic?: boolean; includePending: false }): Omit<PhysicsSnapshot, 'pending'>;
  snapshot(options?: { includeStatic?: boolean; includePending?: true }): PhysicsSnapshot;
  snapshot(options: { includeStatic?: boolean; includePending?: boolean } = {}): PhysicsSnapshot | Omit<PhysicsSnapshot, 'pending'> {
    this.ensure();
    const bodies = options.includeStatic === false ? this.sortedDynamic : [...this.bodies].sort(([a], [b]) => order(a, b));
    const base = {
      bodies: bodies.map(([id, record]) => ({
        spec: record.spec, transform: this.getTransform(id)!, generation: record.generation,
        ...(record.motor ? { motor: record.motor } : {}) })),
      constraints: [...this.constraints].sort(([a], [b]) => order(a, b)).map(([, record]) => record.spec),
    };
    if (options.includePending === false) return base;
    return {
      ...base,
      pending: { add: [...this.pendingAdd], remove: [...this.pendingRemove],
        addConstraints: [...this.pendingAddConstraints], removeConstraints: [...this.pendingRemoveConstraints],
        forces: [...this.forces], impulses: [...this.impulses] },
    };
  }
  /** Small query view for local navigation: excludes loot, actors and pending/constraint state. Specs are shared, frozen. */
  solidPropStates(): Array<{ spec: BodySpec; transform: Transform }> {
    this.ensure();
    return this.sortedDynamic.filter(([, record]) => record.spec.kind === 'prop' && record.spec.collisionProfile !== 'loot')
      .map(([id, record]) => ({ spec: record.spec, transform: this.getTransform(id)! }));
  }
  dispose(): void {
    if (this.disposed) return;
    release.unregister(this);
    this.core.physics_world_free(this.native);
    this.bodies.clear(); this.slotIds = []; this.constraints.clear();
    this.sortedDynamic = []; this.actorCount = 0; this.dynamicCount = 0; this.staticCount = 0;
    this.nextGeneration = 0;
    this.pendingAdd = []; this.pendingRemove = []; this.pendingAddConstraints = []; this.pendingRemoveConstraints = [];
    this.forces = []; this.impulses = []; this.contacts = [];
    this.disposed = true;
  }
}
