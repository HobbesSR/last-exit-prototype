import type { CoreExports } from '../core.ts';
import { AMMO_FAMILIES } from '../enum-tables.ts';
import { physicsRefusal } from '../physics/world.ts';
import type { PhysicsExports } from '../physics/world.ts';
import type { Game } from '../types.ts';
import type { BotIntent } from './bots.ts';
import { applySyncLog, prepareInRunSync } from './boundary.ts';
import { applyHazards, hazardsBlock } from './hazards.ts';
import { applyInteractions, sixBlock } from './phase-six.ts';
import { applyFinish } from './phase-seven.ts';
import { actorId } from './game.ts';
import { applyHookOutput } from './hook.ts';
import { applyCombat, MODE_CASTER_CALL, MODE_PROJECTILE_CALL } from './phase-five.ts';
import { applyLoop, configure } from './phase-three.ts';
import type { ActionsCore } from './phase-three.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import { playersStale, uploadPlayers } from './player-store.ts';
import { sawProjectiles, syncProjectiles } from './projectile-store.ts';
import { syncRegistry } from './registry-store.ts';
import { sightOf } from './sight-runtime.ts';
import { applyItemPoses, ensureFloor } from './world-physics.ts';

// The tick's second call (D4's `tick_finish(intents)`, #1214 stages 6e.5b and 6e.5c, `rust/core/src/lib.rs`): phases 3
// to 7 in one call, which the core builds from the intents and its stores. This packs the intents and what the stores do
// not hold, makes the call and applies each step's output in its order with that step's own applier. Discovery follows
// in Node, after the call.

interface TickFinishExports {
  tick_finish(world: number, collision: number, index: number, gates: number, swept: number): number;
}

/** Words per player's intent (`phase_three::INTENT_ROW`). */
const INTENT_ROW = 18;
const n = (value: number | null | undefined): number => typeof value === 'number' ? value : NaN;

/** Each player's intent in the call's layout, in roster order; a player without one is a row of zeros. */
function intentRows(s: Game, intents: readonly (BotIntent | undefined)[]): number[] {
  const rows: number[] = [], stations = s.map.stations;
  s.players.forEach((_, i) => {
    const intent = intents[i];
    if (!intent) { for (let k = 0; k < INTENT_ROW; k++) rows.push(0); return; }
    const input = intent.input, family = input.dropAmmo?.family;
    rows.push(1, n(input.aim), n(input.slot), n(input.moveSlot?.from), n(input.moveSlot?.to), n(intent.utilitySlot), n(intent.discardSlot),
      input.drop ? 1 : 0, family === undefined ? NaN : AMMO_FAMILIES.indexOf(family), n(input.dropAmmo?.count), input.reload ? 1 : 0,
      input.skill ? 1 : 0, input.attack ? 1 : 0, n(input.x), n(input.y), input.sneak ? 1 : 0, input.interact ? 1 : 0,
      input.transit === undefined ? NaN : stations.findIndex(st => st.id === input.transit));
  });
  return rows;
}

/** Phases 3 to 5: what `phaseThree`, the step and its poses, and phase 5's three calls did. */
export function tickFinish(s: Game, r: PhysicsRuntime, intents: readonly (BotIntent | undefined)[]): void {
  prepareInRunSync(s, r);
  syncRegistry(s, r);
  syncProjectiles(s, r);
  ensureFloor(s, r);
  const native = r.world.boundaryCall(), core = native.core as unknown as ActionsCore & PhysicsExports & TickFinishExports, world = native.world;
  configure(s, r, core as ActionsCore, world);
  if (playersStale(r)) uploadPlayers(s, r, core as unknown as CoreExports & PhysicsExports & Parameters<typeof uploadPlayers>[2], world);
  const markers = r.discontinuities.map(entry => r.world.key(entry.id));
  const six = sixBlock(s, r), hazards = hazardsBlock(s, r);
  const words = [s.tick, s.serial, s.itemSerial ?? 1, s.scatterSerial ?? 0, s.content.gladiatorRespawnTicks, r.discontinuityCapacity,
    s.content.worldPhysics.loot.dropSpeed, markers.length, ...markers, ...intentRows(s, intents), six.length, ...six, hazards.length, ...hazards,
    s.content.worldPhysics.maxImpulse, s.content.actorPhysics.maxImpulse, s.content.durationTicks, s.slots, s.hazardX];
  const sight = sightOf(s), map = sight.queryHandles(s.map), swept = sight.sweptHandle(s.map);
  const pointer = core.physics_boundary_input(world, words.length) >>> 0;
  new Float64Array(core.memory.buffer, pointer, words.length).set(words);
  const at = core.tick_finish(world, map.collision, map.index, map.gates, swept) >>> 0;
  const out = new Float64Array(core.memory.buffer, at, new Float64Array(core.memory.buffer, at, 1)[0]!).slice();
  let k = 4;
  // A section the call did not reach (it ended at a refusal) reads as empty.
  const next = (): Float64Array => {
    if (k >= out.length) return out.subarray(0, 0);
    const length = out[k]!, section = out.subarray(k + 1, k + 1 + length); k += 1 + length; return section;
  };
  // Phase 3.
  const loop = next();
  if (loop.length) applyLoop(s, loop);
  // Phase 4: the drag, the commit, the step, then the poses.
  const drag = next();
  if (drag.length) r.world.adoptFloorDrag(drag);
  const committed = next();
  if (committed.length) {
    r.world.adoptCommit(committed[0]!, committed, 1);
    r.world.adoptQueue(committed[0]! < 0 ? 1 : 0);
    if (committed[0]! < 0) throw physicsRefusal(committed[0]!);
  }
  const step = next();
  if (!step.length) return;
  const result = r.world.parseStep(step);
  // Poses are the ends of the step's paths: the bodies' poses after the solve, as the store took them.
  for (const p of s.players) if (p.status === 'active') {
    const end = result.paths[actorId(p)]?.at(-1);
    if (end) { p.x = end.x; p.y = end.y; p.movedThisTick = result.distance[actorId(p)] ?? 0; }
  }
  applyItemPoses(s, next());
  // Phase 5: the projectiles, the hook's tip, then the casters.
  const projectiles = next();
  if (projectiles.length) applyCombat(s, projectiles, { mode: MODE_PROJECTILE_CALL, bullets: s.projectiles });
  const finished = next();
  if (finished.length) applyHookOutput(s, r, finished, [...r.hooks]);
  const casters = next();
  if (casters.length) applyCombat(s, casters, { mode: MODE_CASTER_CALL });
  // Phase 6: the per-actor loop, then the environment and the traps; a turret's spawns wait for the next tick.
  const interactions = next();
  if (interactions.length) applyInteractions(s, r, interactions, true, []);
  const traps = next();
  if (traps.length) applyHazards(s, r, traps);
  // The core's projectiles took the shots, the flight and the spawns the mirror took.
  sawProjectiles(s, r);
  if (r.pendingSpawns.length > 128) throw new RangeError('pending projectile capacity');
  // Phase 7: the sync, the terminal result, the sync again; the rewind frame is the core's alone.
  const first = next();
  if (first.length) applySyncLog(s, r, first, s.tick);
  const result7 = next();
  if (result7.length) applyFinish(s, result7);
  const second = next();
  if (second.length) applySyncLog(s, r, second, s.tick);
}
