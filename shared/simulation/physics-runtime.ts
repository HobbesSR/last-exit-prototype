import type { PhysicsWorld } from '../physics/world.ts';
import type { PhysicsGameplayState, HookState } from '../physics/types.ts';
import type { Game, GateIdx, ItemId, Player, Projectile, Vec2 } from '../types.ts';
import type { PhysicsIdentities } from './physics-identities.ts';

/** The one physics rules version. Which features a match has is stated by its content, never by this string (26). */
export const PHYSICS_VERSION = 'last-exit-0.8-physics';
export interface PendingAttachment { id: string; a: string; b: string; maxDistance: number }
export interface PhysicsRuntime {
  identities: PhysicsIdentities;
  stepping: boolean;
  hooks: HookState[];
  discontinuityCapacity: number;
  discontinuities: Array<{ id: string; generation: number; kind: 'placed' | 'removed'; tick: number }>;
  world: PhysicsWorld;
  actors: Set<string>;
  items: Set<string>;
  itemLaunches: Map<ItemId, Vec2>;
  /** Dense gate indices in legacy world admission order, retained only for CP1 physics equivalence. */
  gateOrder: readonly GateIdx[];
  /** What the world last saw of each gate, by canonical GateIdx (independent of admission order): 0 nothing yet, 1 open, 2 closed. */
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
  return r && { world: r.world.snapshot({ includeStatic: false, includePending: false }),
    hooks: r.hooks.flatMap(hook => {
      // A stale dense slot cannot be translated back into a trustworthy legacy identity.
      const caster = s.players[hook.casterIdx];
      const target = hook.targetIdx === undefined ? undefined : s.players[hook.targetIdx];
      if (!caster || hook.targetIdx !== undefined && !target) return [];
      return [Object.fromEntries(Object.entries(hook).flatMap(([key, value]) =>
        key === 'tetherId' || key === 'targetActorKey' || key === 'targetIdx' && hook.targetIdx === undefined ? [] :
        key === 'casterIdx' ? [['caster', caster.id]] :
        key === 'targetIdx' ? [['target', target!.id]] : [[key, structuredClone(value)]])) as
        unknown as NonNullable<PhysicsGameplayState['hooks']>[number]];
    }),
    discontinuities: r.discontinuities.map(({ id, generation, kind }) => ({ id, generation, kind })),
    pendingSpawns: structuredClone(r.pendingSpawns), pendingImpulses: structuredClone(r.pendingImpulses),
    pendingAttachments: structuredClone(r.pendingAttachments) };
}
/**
 * The pending queues are the core's (#1214 stage 6d.5): the world keeps them, merges, clamps and bounds them, admits
 * them in phase 1 and filters them by generation after each sync. `pendingImpulses` and `pendingAttachments` are their
 * mirror, read back after every change, for the gameplay snapshot.
 */
export function mirrorPendingQueues(r: PhysicsRuntime): void {
  const { core, world } = r.world.boundaryCall();
  const at = core.physics_queues_dump(world) >>> 0, head = new Float64Array(core.memory.buffer, at, 2);
  const impulses = head[0]!, attachments = head[1]!;
  const rows = new Float64Array(core.memory.buffer, at + 16, impulses * 4 + attachments * 6), idOf = (key: number) => r.world.idOf(key);
  r.pendingImpulses = Array.from({ length: impulses }, (_, i) => ({ id: idOf(rows[i * 4]!), value: { x: rows[i * 4 + 1]!, y: rows[i * 4 + 2]! },
    generation: rows[i * 4 + 3]! }));
  const base = impulses * 4;
  r.pendingAttachments = Array.from({ length: attachments }, (_, i) => {
    const k = base + i * 6;
    return { id: idOf(rows[k]!), a: idOf(rows[k + 1]!), b: idOf(rows[k + 2]!), maxDistance: rows[k + 3]!, generationA: rows[k + 4]!, generationB: rows[k + 5]! };
  });
}

/** Post-solve effects enter the next tick, never a partially completed solve. */
export function enqueuePhysicsImpulse(s: Game, id: string, value: Vec2): void {
  const r = rooms.get(s);
  if (!r) throw new Error('physics mode required');
  r.synchronize();

  if (![value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) throw new TypeError('representable finite impulse required');
  const limit = id.startsWith('actor:') ? s.content.actorPhysics.maxImpulse : s.content.worldPhysics.maxImpulse;
  const key = r.world.key(id), { core, world } = r.world.boundaryCall();
  const code = core.physics_enqueue_impulse(world, key, value.x, value.y, limit);
  if (code === -40) throw new Error('unknown impulse actor');
  if (code === -41) throw new RangeError('pending impulse capacity');
  mirrorPendingQueues(r);
}
export function enqueuePhysicsAttachment(s: Game, attachment: PendingAttachment): void {
  const r = rooms.get(s);
  if (!r) throw new Error('physics mode required');
  r.synchronize();
  if (r.pendingAttachments.length >= 8) throw new RangeError('pending attachment capacity');
  if (!attachment.id || !attachment.a || !attachment.b || !Number.isFinite(attachment.maxDistance) || attachment.maxDistance <= 0 || attachment.maxDistance > 1e9) throw new TypeError('invalid attachment');
  const keys = [attachment.id, attachment.a, attachment.b].map(id => r.world.key(id)), { core, world } = r.world.boundaryCall();
  const code = core.physics_enqueue_attachment(world, keys[0]!, keys[1]!, keys[2]!, attachment.maxDistance);
  if (code === -43) throw new RangeError('pending attachment capacity');
  if (code === -42) throw new Error('unknown attachment actor');
  mirrorPendingQueues(r);
}
