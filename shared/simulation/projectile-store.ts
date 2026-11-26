import type { Game, PlayerId, Projectile } from '../types.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import { playerById, playerIndex } from './relations.ts';

// The core's projectiles (#1214, docs/27 "The state flip", step 6e.3): the world keeps the projectiles in flight and a
// turret's pending spawns (`World::projectiles`, `pending_spawns`), and `s.projectiles` and `pendingSpawns` are their
// mirror. Each writer changes both: phase 3's shots (op 2), the hazards' spawns, phase 1's admission of the spawns, and
// phase 5's flight. The lists are uploaded only when Node changed them without those facts: a scenario's projectiles,
// or the retained TypeScript attack.

/** Words per projectile (`combat::BULLET_ROW`). */
const ROW = 8;

interface ProjectileExports {
  projectiles_load(world: number, count: number, pending: number): void;
  projectiles_spawn(world: number): void;
  projectiles_dump(world: number): number;
}

/** The lists each runtime's core matches, and their lengths then. */
const seen = new WeakMap<PhysicsRuntime, { list: readonly Projectile[]; length: number; pending: readonly Projectile[]; pendingLength: number }>();

function rows(s: Game, list: readonly Projectile[]): number[] {
  const out: number[] = [];
  for (const b of list) {
    const owner = playerById(s, b.owner as PlayerId);
    out.push(b.id, owner ? playerIndex(s, owner) : -1, b.x, b.y, b.dx, b.dy, b.life, b.damage);
  }
  return out;
}

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

/** Upload both lists where Node changed them without the facts. */
function syncProjectiles(s: Game, r: PhysicsRuntime): void {
  if (projectilesCurrent(s, r)) return;
  const words = [...rows(s, s.projectiles), ...rows(s, r.pendingSpawns)];
  const { core, world } = r.world.boundaryCall();
  const pointer = core.physics_boundary_input(world, words.length) >>> 0;
  new Float64Array(core.memory.buffer, pointer, words.length).set(words);
  (core as typeof core & ProjectileExports).projectiles_load(world, s.projectiles.length, r.pendingSpawns.length);
  sawProjectiles(s, r);
}

/** Phase 1: the pending spawns enter the projectiles, in the core and the mirror. */
export function admitSpawns(s: Game, r: PhysicsRuntime): void {
  syncProjectiles(s, r);
  s.projectiles.push(...r.pendingSpawns.splice(0));
  const { core, world } = r.world.boundaryCall();
  (core as typeof core & ProjectileExports).projectiles_spawn(world);
  sawProjectiles(s, r);
}

/** Where the core's lists differ from the mirror's, as lines; empty when they agree. For tests. */
export function projectileDrift(s: Game, r: PhysicsRuntime): string[] {
  if (!projectilesCurrent(s, r)) return ['the core has not seen the mirror'];
  const { core, world } = r.world.boundaryCall();
  const at = (core as typeof core & ProjectileExports).projectiles_dump(world) >>> 0;
  const [count, pending] = new Float64Array(core.memory.buffer, at, 2);
  if (count !== s.projectiles.length || pending !== r.pendingSpawns.length)
    return [`the core holds ${count} and ${pending}, the mirror ${s.projectiles.length} and ${r.pendingSpawns.length}`];
  const kept = new Float64Array(core.memory.buffer, at + 16, (count! + pending!) * ROW);
  const fresh = [...rows(s, s.projectiles), ...rows(s, r.pendingSpawns)], out: string[] = [];
  fresh.forEach((v, k) => { if (!Object.is(kept[k], v)) out.push(`${Math.floor(k / ROW)}.${k % ROW}: ${kept[k]} != ${v}`); });
  return out;
}
