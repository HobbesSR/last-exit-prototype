import type { PhysicsWorld } from '../physics/world.ts';
import type { PhysicsGameplayState, HookState } from '../physics/types.ts';
import type { Game, Gate, Player, Projectile, Vec2 } from '../types.ts';
import { hypot } from '../math.ts';

/** The one physics rules version. Which features a match has is stated by its content, never by this string (26). */
export const PHYSICS_VERSION = 'last-exit-0.8-physics';
export interface PendingAttachment { id: string; a: string; b: string; maxDistance: number }
export interface PhysicsRuntime {
  hooks: HookState[];
  discontinuityCapacity: number;
  discontinuities: Array<{ id: string; generation: number; kind: 'placed' | 'removed'; tick: number }>;
  world: PhysicsWorld;
  actors: Set<string>;
  items: Set<string>;
  itemLaunches: Map<string, Vec2>;
  /** The pinned gate list in id order, sorted once: sync pushes gate changes into the world in this order. */
  gateOrder: readonly Gate[];
  /** What the world last saw of each gate, by its place in `gateOrder`: 0 nothing yet, 1 open, 2 closed. */
  gates: Uint8Array;
  synchronize: (options?: { deferItemAdmission?: boolean }) => void;
  placement: (p: Player, destination: Vec2) => Vec2 | null;
  pendingSpawns: Projectile[];
  pendingImpulses: { id: string; value: Vec2; generation: number }[];
  pendingAttachments: (PendingAttachment & { generationA: number; generationB: number })[];
}
const rooms = new WeakMap<Game, PhysicsRuntime>();
/** Only the latest boundary per ID is kept: the presentation capture reads one per body. */
export function markPhysicsDiscontinuity(r: PhysicsRuntime, value: PhysicsRuntime['discontinuities'][number]): void {
  const index = r.discontinuities.findIndex(entry => entry.id === value.id);
  if (index >= 0) r.discontinuities[index] = value;
  else {
    if (r.discontinuities.length >= r.discontinuityCapacity) throw new RangeError('physics discontinuity capacity');
    r.discontinuities.push(value);
  }
}
export const physicsRuntime = (s: Game): PhysicsRuntime | undefined => rooms.get(s);
export function attachPhysics(s: Game, runtime: PhysicsRuntime): void {
  if (rooms.has(s)) throw new Error('physics already attached');
  rooms.set(s, runtime);
}
export function disposePhysics(s: Game): void {
  const runtime = rooms.get(s);
  if (runtime) { runtime.world.dispose(); rooms.delete(s); }
}
export function physicsState(s: Game): PhysicsGameplayState | undefined {
  const r = rooms.get(s);
  // The world's snapshot is already the caller's own apart from its frozen, shared records; only the runtime's
  // own queues, which it edits in place, are copied (#655).
  return r && { profile: s.version, settings: r.world.settings, world: r.world.snapshot({ includeStatic: false }),
    hooks: structuredClone(r.hooks),
    discontinuities: r.discontinuities.map(({ id, generation, kind }) => ({ id, generation, kind })),
    pendingSpawns: structuredClone(r.pendingSpawns), pendingImpulses: structuredClone(r.pendingImpulses),
    pendingAttachments: structuredClone(r.pendingAttachments) };
}
/** Post-solve effects enter the next tick, never a partially completed solve. */
export function enqueuePhysicsImpulse(s: Game, id: string, value: Vec2): void {
  const r = rooms.get(s);
  if (!r) throw new Error('physics mode required');
  r.synchronize();

  if (![value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) throw new TypeError('representable finite impulse required');
  const generation = r.world.getGeneration(id);
  if (generation === undefined) throw new Error('unknown impulse actor');
  const magnitude = hypot(value.x, value.y), limit = id.startsWith('actor:')
    ? s.content.actorPhysics.maxImpulse : s.content.worldPhysics.maxImpulse;
  const scale = magnitude > limit ? limit / magnitude : 1;
  const previous = r.pendingImpulses.find(entry => entry.id === id && entry.generation === generation);
  if (previous) {
    const x = previous.value.x + value.x * scale, y = previous.value.y + value.y * scale;
    const total = hypot(x, y), factor = total > limit ? limit / total : 1;
    previous.value = { x: x * factor, y: y * factor };
  } else {
    if (r.pendingImpulses.length >= 128) throw new RangeError('pending impulse capacity');
    r.pendingImpulses.push({ id, value: { x: value.x * scale, y: value.y * scale }, generation });
  }
}
export function enqueuePhysicsAttachment(s: Game, attachment: PendingAttachment): void {
  const r = rooms.get(s);
  if (!r) throw new Error('physics mode required');
  r.synchronize();
  if (r.pendingAttachments.length >= 8) throw new RangeError('pending attachment capacity');
  if (!attachment.id || !attachment.a || !attachment.b || !Number.isFinite(attachment.maxDistance) || attachment.maxDistance <= 0 || attachment.maxDistance > 1e9) throw new TypeError('invalid attachment');
  const generationA = r.world.getGeneration(attachment.a), generationB = r.world.getGeneration(attachment.b);
  if (generationA === undefined || generationB === undefined) throw new Error('unknown attachment actor');
  r.pendingAttachments.push({ ...attachment, generationA, generationB });
}
