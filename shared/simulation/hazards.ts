import { TRAP_KINDS } from '../enum-tables.ts';
import type { Game, PlayerId, Trap } from '../types.ts';
import { applyLog, applyPlayerRows } from './phase-five.ts';
import { playersStale, uploadPlayers } from './player-store.ts';
import { applyElimination, configure, eliminateInCore } from './phase-three.ts';
import { syncRegistry } from './registry-store.ts';
import type { ActionsCore } from './phase-three.ts';
import { mirrorPendingQueues, physicsRuntime } from './physics-runtime.ts';
import { applySyncLog, prepareInRunSync } from './boundary.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import { playerById, playerIndex } from './relations.ts';
import { sightOf } from './sight-runtime.ts';
import { start as profileStart, stop as profileStop } from '../profiler.ts';

// The rest of phase 6 runs in the core (`rust/core/src/hazards.rs`, #1245, docs/27 "The state flip", step 5e.2):
// `applyEnvironment` (the hazard wall and areas) for each active actor in `ordered(s)` order, then `stepTraps` in map
// order. The traps are the core's since #1214 stage 6b: it keeps them between calls, and `s.traps` is their mirror,
// which only this adapter's facts write. Their rows cross only when a call uploads a list: one this runtime has not
// uploaded (a new or replaced `s.traps`, or one whose length changed), or after `setTrap`. Each call still packs the
// roster and the hazard areas, and this writes back the players' changed fields, the log (effects and the turret's
// spawns, which wait in `pendingSpawns` for the next tick) and each trap's writes, in the TypeScript's order, so a
// trap's keys keep theirs. A kill stops the call for the
// elimination (`eliminateInCore`, its drops each at 5c.2's sync boundary), then resumes from the core's cursor,
// everything repacked. A mine's explosion is carried out in the run (#1214 stage 6d.6d): the core syncs and queues its
// impulses, and this applies the sync's log. A call whose traps include a mine sends what that needs.
interface HazardExports {
  hazards_input(world: number, words: number): number;
  hazards_run(world: number, collision: number, index: number, gates: number, swept: number): number;
}
type Core = ActionsCore & HazardExports;
const HEADER = 11, CONTENT = 22, AREA_ROW = 4, TRAP_ROW = 10, OUT_HEADER = 8, OUT_TRAP = 11;
const STOP_ELIMINATION = 1, OP_SPAWN = 3, OP_SYNC = 5, OP_REFUSED = 6, OP_ELIMINATED = 9, OUT_ROW = 5;
/** `enqueuePhysicsImpulse`'s refusals, as the core reports them (`world::E_*`, `hazards::E_UNREPRESENTABLE_IMPULSE`). */
const E_UNKNOWN_IMPULSE_ACTOR = -40, E_IMPULSE_CAPACITY = -41, E_UNREPRESENTABLE_IMPULSE = -44;
const W_COOLDOWN = 1, W_SPENT = 2, W_AIMING = 4, W_HEADING = 8, W_FIRING = 16, W_WARNING = 32, W_TARGET = 64, W_POSITION = 128;

/** The trap list each runtime's core keeps, as uploaded, and its length then; absent until the first call, or after `setTrap`. */
const uploaded = new WeakMap<PhysicsRuntime, { list: readonly Trap[]; length: number }>();
const NO_TRAPS: Trap[] = [];

/**
 * A between-tick command (27, D5): write fields of the trap at `index` in the mirror, which the core takes at the next
 * call, before any rule reads a trap. Tests and tools arrange traps through it or by replacing `s.traps`; play never
 * calls it.
 */
export function setTrap(s: Game, index: number, fields: Partial<Trap>): void {
  const trap = s.traps[index];
  if (!trap) throw new RangeError(`no trap ${index}`);
  Object.assign(trap, fields);
  const r = physicsRuntime(s);
  if (r) uploaded.delete(r);
}

/** Which parts of the rest of phase 6 a call runs. */
interface Parts { environment: boolean; traps: boolean }

/** A trap's writes, in the order `stepTraps` made them for every kind: cooldown, spent, aiming, target, heading, position, firing, warning. */
function applyTrap(s: Game, trap: Trap, out: Float64Array, at: number): void {
  const mask = out[at + 1]!;
  if (mask & W_COOLDOWN) trap.cooldown = out[at + 2]!;
  if (mask & W_SPENT) trap.spent = out[at + 3] === 1;
  if (mask & W_AIMING) trap.aiming = out[at + 4] === 1;
  if (mask & W_TARGET) trap.targetId = out[at + 8]! >= 0 ? s.players[out[at + 8]!]!.id : null;
  if (mask & W_HEADING) trap.heading = out[at + 5]!;
  if (mask & W_POSITION) { trap.x = out[at + 9]!; trap.y = out[at + 10]!; }
  if (mask & W_FIRING) trap.firing = out[at + 6] === 1;
  if (mask & W_WARNING) trap.warning = out[at + 7] === 1;
}

/** One call; returns the stop it ended at, if any. */
function call(s: Game, parts: Parts, resume: boolean): { kind: number; which: number; source: number } | null {
  const r = physicsRuntime(s);
  if (!r) throw new Error("phase 6's environment and traps need the game's physics world");
  const native = r.world.boundaryCall(), core = native.core as Core, world = native.world;
  configure(s, r, core, world);
  const players = s.players, traps = s.traps ?? NO_TRAPS, areas = s.map.hazards, t = s.content.traps;
  const kept = uploaded.get(r), upload = !kept || kept.list !== traps || kept.length !== traps.length;
  const map = sightOf(s).queryHandles(s.map);
  if (map.core !== core) throw new Error('phase 6 and sight are bound to different cores');
  // The players come from the core's store (`player-store.ts`, stage 6c). Map preparation and the upload can grow
  // memory, so the input is viewed only after them, and written there in place.
  if (playersStale(r)) uploadPlayers(s, r, core, world);
  // A mine's explosion syncs and queues its impulses inside the run (6d.6d): the sync's markers and the impulse limits
  // cross, after the traps. Interning comes before the input is viewed.
  // A kill's elimination (6e.2) and a mine's explosion are carried out in the run: what their syncs and the elimination's
  // call need follows the traps.
  prepareInRunSync(s, r);
  syncRegistry(s, r);
  const markers = r.discontinuities.map(entry => r.world.key(entry.id));
  const inRunWords = [r.discontinuityCapacity, players.length, s.content.worldPhysics.maxImpulse, s.content.actorPhysics.maxImpulse,
    s.itemSerial ?? 1, s.scatterSerial ?? 0, s.content.gladiatorRespawnTicks, s.content.worldPhysics.loot.dropSpeed, markers.length, ...markers];
  const swept = sightOf(s).sweptHandle(s.map);
  const words = HEADER + CONTENT + areas.length * AREA_ROW + (upload ? traps.length * TRAP_ROW : 0) + inRunWords.length;
  const ptr = core.hazards_input(world, words) >>> 0, data = new Float64Array(core.memory.buffer, ptr, words);
  data.set([resume ? 1 : 0, s.tick, s.serial, players.length, traps.length, areas.length, s.hazardX,
    parts.environment ? 1 : 0, parts.traps ? 1 : 0, upload ? 1 : 0, 1,
    t.mine.trigger, t.mine.blast, t.mine.damage,
    t.turret.range, t.turret.cooldown, t.turret.speed, t.turret.damage, t.turret.life,
    t.flame.cycle, t.flame.warnAt, t.flame.fireAt, t.flame.interval, t.flame.range, t.flame.cone, t.flame.damage,
    t.spider.leash, t.spider.acquire, t.spider.step, t.spider.grapple, t.spider.cooldown, t.spider.stun, t.spider.damage]);
  let at = HEADER + CONTENT;
  for (const h of areas) { data[at++] = h.x; data[at++] = h.y; data[at++] = h.w; data[at++] = h.h; }
  if (upload) for (const trap of traps) {
    const target = trap.targetId == null ? undefined : playerById(s, trap.targetId as PlayerId);
    data[at++] = TRAP_KINDS.indexOf(trap.kind); data[at++] = trap.x; data[at++] = trap.y; data[at++] = trap.homeX; data[at++] = trap.homeY;
    data[at++] = trap.heading; data[at++] = trap.offset; data[at++] = trap.cooldown || 0; data[at++] = trap.spent ? 1 : 0;
    data[at++] = target ? playerIndex(s, target) : -1;
  }
  data.set(inRunWords, at);
  profileStart('sim.environment.core');
  const outPtr = core.hazards_run(world, map.collision, map.index, map.gates, swept) >>> 0;
  profileStop('sim.environment.core');
  if (upload) uploaded.set(r, { list: traps, length: traps.length });
  // Copied: an explosion's sync and an elimination applied from the log call into the core.
  const out = new Float64Array(core.memory.buffer, outPtr, new Float64Array(core.memory.buffer, outPtr, 1)[0]!).slice();
  let exploded = false, refused: { code: number; key: number } | undefined;
  // The log first, then the rows, which are the store's at the end of the call (6e.2).
  at = applyLog(s, out, OUT_HEADER + out[5]! * OUT_ROW, out[6]!, (op, k) => {
    if (op === OP_SYNC) {
      // A mine's explosion: its sync, as `enqueueExplosionImpulses` ran it; the impulses are queued in the core.
      exploded = true;
      applySyncLog(s, r, out.subarray(k, k + out[k - 1]!), r.stepping ? s.tick : s.tick + 1);
    } else if (op === OP_REFUSED) refused = { code: out[k]!, key: out[k + 1]! };
    else if (op === OP_ELIMINATED) {
      // A kill's elimination, carried out in the core: phase 3's output, applied as `eliminateInCore`'s.
      const source = out[k + 1]!;
      applyElimination(s, out.subarray(k + 2, k + out[k - 1]!), players[out[k]!]!, source >= 0 ? players[source]! : null);
    }
    else if (op === OP_SPAWN) r.pendingSpawns.push({ id: out[k]!, owner: traps[out[k + 1]!]!.id, trap: true, x: out[k + 2]!, y: out[k + 3]!,
      dx: out[k + 4]!, dy: out[k + 5]!, damage: out[k + 6]!, life: out[k + 7]! });
    else throw new Error(`unknown phase 6 fact ${op}`);
  });
  applyPlayerRows(s, out, OUT_HEADER);
  s.serial = out[1]!;
  for (let i = 0; i < out[7]!; i++, at += OUT_TRAP) applyTrap(s, traps[out[at]!]!, out, at);
  // The impulses' mirror follows the core's queue, as each `enqueuePhysicsImpulse` read it back.
  if (exploded) mirrorPendingQueues(r);
  // `enqueuePhysicsImpulse`'s throws, once the call's writes are applied, as they were at the stop.
  if (refused?.code === E_UNKNOWN_IMPULSE_ACTOR) throw new Error('unknown impulse actor');
  if (refused?.code === E_IMPULSE_CAPACITY) throw new RangeError('pending impulse capacity');
  if (refused?.code === E_UNREPRESENTABLE_IMPULSE) throw new TypeError('representable finite impulse required');
  if (refused) throw new Error(`impulse refused ${refused.code} for ${r.world.idOf(refused.key)}`);
  return out[2] ? { kind: out[2]!, which: out[3]!, source: out[4]! } : null;
}

/** Run to the end, eliminating at each stop, and resuming. */
function drive(s: Game, parts: Parts): void {
  for (let stop = call(s, parts, false); stop; stop = call(s, parts, true)) {
    if (stop.kind === STOP_ELIMINATION) eliminateInCore(s, s.players[stop.which]!, stop.source >= 0 ? s.players[stop.source]! : null);
    else throw new Error(`unknown phase 6 stop ${stop.kind}`);
  }
}

/** The rest of phase 6: the environment, then the traps. A turret's spawns wait in `pendingSpawns` for the next tick. */
export function environmentAndTraps(s: Game): void { drive(s, { environment: true, traps: true }); }
/** `applyEnvironment` for every active actor, for scenarios. */
export function applyEnvironment(s: Game): void { drive(s, { environment: true, traps: false }); }
/** `stepTraps`, for scenarios. */
export function stepTraps(s: Game): void { drive(s, { environment: false, traps: true }); }
