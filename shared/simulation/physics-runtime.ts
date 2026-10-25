import type { PhysicsWorld } from '../physics/world.ts';
import type { PhysicsGameplayState, HookState } from '../physics/types.ts';
import type { Game, Player, Projectile, Vec2 } from '../types.ts';

export const PHYSICS_VERSION = 'last-exit-0.8-physics-1';
export const PHYSICS_HOOK_VERSION = 'last-exit-0.8-physics-6';
export const PHYSICS_NAVIGATION_VERSION = 'last-exit-0.8-physics-8';
export interface PendingAttachment { id: string; a: string; b: string; maxDistance: number }
export interface PhysicsRuntime {
  hooks: HookState[];
  discontinuityCapacity: number;
  discontinuities: Array<{ id: string; generation: number; kind: 'placed' | 'removed'; tick: number }>;
  world: PhysicsWorld;
  actors: Set<string>;
  items: Set<string>;
  itemLaunches: Map<string, Vec2>;
  gates: Map<string, boolean>;
  synchronize: (options?: { deferItemAdmission?: boolean }) => void;
  placement: (p: Player, destination: Vec2) => Vec2 | null;
  pendingSpawns: Projectile[];
  pendingImpulses: { id: string; value: Vec2; generation: number }[];
  pendingAttachments: (PendingAttachment & { generationA: number; generationB: number })[];
}
const rooms = new WeakMap<Game, PhysicsRuntime>();
/** Only the latest boundary per ID is needed by a future presentation/prediction reader. */
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
  return r && structuredClone({ profile: s.version, settings: r.world.settings, world: r.world.snapshot({ includeStatic: false }),
    ...(s.content.hook ? { hooks: r.hooks } : {}),
    ...(s.content.actorPhysics ? { discontinuities: r.discontinuities.map(({ id, generation, kind }) => ({ id, generation, kind })) } : {}),
    pendingSpawns: r.pendingSpawns, pendingImpulses: r.pendingImpulses, pendingAttachments: r.pendingAttachments });
}
/** Post-solve effects enter the next tick, never a partially completed solve. */
export function enqueuePhysicsImpulse(s: Game, id: string, value: Vec2): void {
  const r = rooms.get(s);
  if (!r) throw new Error('physics mode required');
  r.synchronize();

  if (![value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) throw new TypeError('representable finite impulse required');
  const generation = r.world.getGeneration(id);
  if (generation === undefined) throw new Error('unknown impulse actor');
  const magnitude = Math.hypot(value.x, value.y), limit = !s.content.worldPhysics || id.startsWith('actor:')
    ? s.content.actorPhysics?.maxImpulse ?? Infinity : s.content.worldPhysics?.maxImpulse ?? Infinity;
  const scale = magnitude > limit ? limit / magnitude : 1;
  const previous = s.content.worldPhysics && r.pendingImpulses.find(entry => entry.id === id && entry.generation === generation);
  if (previous) {
    const x = previous.value.x + value.x * scale, y = previous.value.y + value.y * scale;
    const total = Math.hypot(x, y), factor = total > limit ? limit / total : 1;
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
