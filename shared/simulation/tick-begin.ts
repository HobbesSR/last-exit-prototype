import type { CoreExports } from '../core.ts';
import { physicsRefusal } from '../physics/world.ts';
import type { PhysicsExports } from '../physics/world.ts';
import type { Game } from '../types.ts';
import { applySyncLog, applyAdmission, prepareInRunSync } from './boundary.ts';
import { applyHookOutput } from './hook.ts';
import { applyPhaseOne, packPhaseOne } from './phase-one.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import { projectilesCurrent, sawProjectiles, syncProjectiles } from './projectile-store.ts';
import { syncRegistry } from './registry-store.ts';
import { sightOf } from './sight-runtime.ts';

// The tick's first call (D4's `tick_begin`, #1214 stage 6e.5, `rust/core/src/lib.rs`): phase 1, the markers' trim, the
// body sync, the hooks' revalidation, a turret's spawns, the pending admission and the commit, in one call, where they
// were six. This makes the call and applies each step's output in its order, with each step's own applier.

interface TickBeginExports {
  tick_begin(phase: number, world: number, collision: number, index: number, gates: number, swept: number): number;
}

/** Phase 1 and the boundary it ends at: what `beginTick` and the five calls after it did. */
export function tickBegin(s: Game, r: PhysicsRuntime): void {
  // The core's stores follow the mirror where Node changed it between ticks.
  prepareInRunSync(s, r);
  syncRegistry(s, r);
  syncProjectiles(s, r);
  const hooks = [...r.hooks], projectiles = projectilesCurrent(s, r);
  const { core: bound, phase } = packPhaseOne(s);
  const core = bound as unknown as CoreExports & PhysicsExports & TickBeginExports;
  // The markers with their ticks: the core keeps those the new tick still captures. Keys are interned first.
  const markers = r.discontinuities.flatMap(entry => [r.world.key(entry.id), entry.tick]);
  const sight = sightOf(s), map = sight.queryHandles(s.map), swept = sight.sweptHandle(s.map);
  const { world } = r.world.boundaryCall();
  const words2 = 2 + markers.length;
  const pointer = core.physics_boundary_input(world, words2) >>> 0;
  new Float64Array(core.memory.buffer, pointer, words2).set([r.discontinuityCapacity, markers.length / 2, ...markers]);
  const at = core.tick_begin(phase, world, map.collision, map.index, map.gates, swept) >>> 0;
  const out = new Float64Array(core.memory.buffer, at, new Float64Array(core.memory.buffer, at, 1)[0]!).slice();
  let k = 2;
  const next = (): Float64Array => { const length = out[k]!, section = out.subarray(k + 1, k + 1 + length); k += 1 + length; return section; };
  const first = next(), state = out[1]!;
  // Phase 1's output: its count of facts, then three words each.
  applyPhaseOne(s, first.subarray(0, state), first.subarray(state + 1, state + 1 + first[state]! * 3));
  // Each marker reaches exactly one stepped capture: its own tick's, or the next after a between-tick change.
  r.discontinuities = r.discontinuities.filter(entry => entry.tick >= s.tick);
  applySyncLog(s, r, next(), s.tick);
  const prepared = next();
  if (prepared.length) applyHookOutput(s, r, prepared, hooks);
  // Trap spawns are projectile records, which the core admitted too (6e.3).
  s.projectiles.push(...r.pendingSpawns.splice(0));
  if (projectiles) sawProjectiles(s, r);
  const admitted = next();
  if (admitted.length) applyAdmission(s, r, admitted);
  const committed = next();
  if (committed.length) {
    r.world.adoptCommit(committed[0]!, committed, 1);
    r.world.adoptQueue(committed[0]! < 0 ? 1 : 0);
    if (committed[0]! < 0) throw physicsRefusal(committed[0]!);
  }
}
