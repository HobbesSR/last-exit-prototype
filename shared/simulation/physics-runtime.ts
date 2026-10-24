import type { PhysicsWorld } from '../physics/world.ts';
import type { PhysicsGameplayState } from '../physics/types.ts';
import type { Game, Projectile, Vec2 } from '../types.ts';

export const PHYSICS_VERSION = 'last-exit-0.8-physics-1';
export interface PendingAttachment { id: string; a: string; b: string; maxDistance: number }
export interface PhysicsRuntime {
  world: PhysicsWorld;
  actors: Set<string>;
  gates: Map<string, boolean>;
  synchronize: () => void;
  pendingSpawns: Projectile[];
  pendingImpulses: { id: string; value: Vec2; generation: number }[];
  pendingAttachments: (PendingAttachment & { generationA: number; generationB: number })[];
}
const rooms = new WeakMap<Game, PhysicsRuntime>();
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
  return r && structuredClone({ profile: PHYSICS_VERSION, settings: r.world.settings, world: r.world.snapshot({ includeStatic: false }),
    pendingSpawns: r.pendingSpawns, pendingImpulses: r.pendingImpulses, pendingAttachments: r.pendingAttachments });
}
/** Post-solve effects enter the next tick, never a partially completed solve. */
export function enqueuePhysicsImpulse(s: Game, id: string, value: Vec2): void {
  const r = rooms.get(s);
  if (!r) throw new Error('physics mode required');
  r.synchronize();
  if (r.pendingImpulses.length >= 128) throw new RangeError('pending impulse capacity');
  if (![value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) throw new TypeError('representable finite impulse required');
  const generation = r.world.getGeneration(id);
  if (generation === undefined) throw new Error('unknown impulse actor');
  r.pendingImpulses.push({ id, value: { ...value }, generation });
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
