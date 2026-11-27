import type { Game, Projectile } from '../types.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';

// The core's projectiles (#1214, docs/27 "The state flip", step 6e.3): the world keeps the projectiles in flight and a
// turret's pending spawns (`World::projectiles`, `pending_spawns`), and `s.projectiles` and `pendingSpawns` are their
// mirror.

/** The lists each runtime's core matches, and their lengths then. */
const seen = new WeakMap<PhysicsRuntime, { list: readonly Projectile[]; length: number; pending: readonly Projectile[]; pendingLength: number }>();

/** Whether the core's lists are the mirror's. */
export function projectilesCurrent(s: Game, r: PhysicsRuntime): boolean {
  const last = seen.get(r);
  return !!last && last.list === s.projectiles && last.length === s.projectiles.length
    && last.pending === r.pendingSpawns && last.pendingLength === r.pendingSpawns.length;
}

/** The core's lists now match the mirror's. */
export function sawProjectiles(s: Game, r: PhysicsRuntime): void {
  seen.set(r, { list: s.projectiles, length: s.projectiles.length, pending: r.pendingSpawns, pendingLength: r.pendingSpawns.length });
}
