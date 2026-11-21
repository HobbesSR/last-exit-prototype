import { EFFECT_KINDS } from '../enum-tables.ts';
import type { Game, Player, Projectile, Vec2 } from '../types.ts';
import { configure, eliminateInCore } from './phase-three.ts';
import type { ActionsCore } from './phase-three.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { playersStale, uploadPlayers } from './player-store.ts';
import { playerById, playerIndex } from './relations.ts';
import { sightOf } from './sight-runtime.ts';
import { start as profileStart, stop as profileStop } from '../profiler.ts';

// Phase 5's combat runs in the core (`rust/core/src/combat.rs`, #1242, docs/27 "The state flip", step 5d.2): projectile
// flight, the end-of-tick casters (the warden skill, then the gladiator attack) and `damage`, with the rewind reads
// (`asSeenBy`) the casters resolve against, from the frames phase 7 keeps in the core (`phase_seven.rs`). The records
// stay here (D1), apart from the players' fields the run reads, which come from the core's player store (`player-store.ts`,
// #1214 stage 6c), uploaded only between ticks (6c.2); the run writes back only what the rules wrote. A kill stops
// the run before anything of the elimination is written; the elimination runs in the core too (`eliminateInCore`), each
// mandatory drop at its own sync boundary (5c.2), and the run then resumes where it stopped, from what the core kept.
interface CombatExports {
  combat_input(world: number, words: number): number;
  combat_run(world: number, index: number, gates: number, swept: number): number;
}
type Core = ActionsCore & CombatExports;
const MODE_PROJECTILES = 0, MODE_CASTERS = 1, MODE_DAMAGE = 2;
const OUT_HEADER = 9, OUT_ROW = 5, OP_EFFECT = 1, OP_AGGRESSION = 2;
const STEPS = 4;

/** A caster in `ordered(s)` order, with what it pressed this tick. */
export interface Caster { player: Player; skill: boolean; attack: boolean }

interface Call {
  mode: number;
  resume: boolean;
  paths?: Record<string, Vec2[]>;
  bullets?: readonly Projectile[];
  casters?: readonly Caster[];
  damage?: { target: Player; amount: number; source: Player | null };
}

/** Write back what a run changed of each player (`combat::OUT_ROW`); returns where the rows end. */
export function applyPlayerRows(s: Game, out: Float64Array, at: number): number {
  for (const p of s.players) {
    if (!Object.is(p.hp, out[at])) p.hp = out[at]!;
    if (!Object.is(p.shield, out[at + 1])) p.shield = out[at + 1]!;
    if (!Object.is(p.cooldown, out[at + 2])) p.cooldown = out[at + 2]!;
    if (!Object.is(p.attackCd, out[at + 3])) p.attackCd = out[at + 3]!;
    if (!Object.is(p.stun, out[at + 4])) p.stun = out[at + 4]!;
    at += OUT_ROW;
  }
  return at;
}

/**
 * Apply a run's log of `length` words from `at`, in order: effects and aggression, and `other` for an op this module
 * does not own (phase 6's turret spawns). Returns where the log ends.
 */
export function applyLog(s: Game, out: Float64Array, at: number, length: number, other?: (op: number, at: number) => void): number {
  const players = s.players, end = at + length;
  while (at < end) {
    const op = out[at]!, len = out[at + 1]!; at += 2;
    if (op === OP_EFFECT) s.effects.push({ id: out[at]!, x: out[at + 1]!, y: out[at + 2]!, kind: EFFECT_KINDS[out[at + 3]!]!, radius: out[at + 4]!, life: 12 });
    else if (op === OP_AGGRESSION) { const t = players[out[at]!]!; t.aggressor = players[out[at + 1]!]!.id; t.aggressionUntil = out[at + 2]!; }
    else if (other) other(op, at);
    else throw new Error(`unknown combat fact ${op}`);
    at += len;
  }
  return end;
}

/** One call; returns the elimination it stopped at, if any. */
function call(s: Game, c: Call): { target: Player; source: Player | null } | null {
  const r = physicsRuntime(s);
  if (!r) throw new Error('phase 5 needs the game\'s physics world');
  const native = r.world.boundaryCall(), core = native.core as Core, world = native.world;
  configure(s, r, core, world);
  const players = s.players, bullets = c.resume ? [] : c.bullets ?? [], casters = c.resume ? [] : c.casters ?? [];
  // The rewind frames are the core's own (phase 7, `phase_seven.rs`), so none cross here.
  const damage = c.damage;
  const data: number[] = [c.mode, c.resume ? 1 : 0, s.tick, s.serial, players.length, bullets.length, casters.length,
    damage ? playerIndex(s, damage.target) : NaN, damage?.amount ?? NaN, damage?.source ? playerIndex(s, damage.source) : -1];
  const paths = c.mode === MODE_PROJECTILES && !c.resume ? c.paths ?? {} : undefined;
  if (paths) players.forEach(p => {
    const path = paths[`actor:${p.id}`];
    if (!path) { data.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); return; }
    data.push(1);
    for (let k = 0; k <= STEPS; k++) data.push(path[k]!.x, path[k]!.y);
  });
  for (const b of bullets) {
    const owner = playerById(s, b.owner);
    data.push(b.id, owner ? playerIndex(s, owner) : -1, b.x, b.y, b.dx, b.dy, b.life, b.damage);
  }
  for (const k of casters) data.push(playerIndex(s, k.player), k.skill ? 1 : 0, k.attack ? 1 : 0);
  // Map preparation can grow memory; view the input only after it.
  const sight = sightOf(s), map = sight.queryHandles(s.map);
  const swept = c.mode === MODE_PROJECTILES && !c.resume ? sight.sweptHandle(s.map) : 0;
  if (map.core !== core) throw new Error('phase 5 and sight are bound to different cores');
  if (playersStale(r)) uploadPlayers(s, r, core, world);
  const ptr = core.combat_input(world, data.length) >>> 0;
  new Float64Array(core.memory.buffer, ptr, data.length).set(data);
  // Only phase 5's own runs are timed (42.71); damage from phase 6 is not.
  const timed = c.mode !== MODE_DAMAGE;
  if (timed) profileStart('sim.projectiles.core');
  const outPtr = core.combat_run(world, map.index, map.gates, swept) >>> 0;
  if (timed) profileStop('sim.projectiles.core');
  const out = new Float64Array(core.memory.buffer, outPtr, new Float64Array(core.memory.buffer, outPtr, 1)[0]!).slice();
  let at = applyPlayerRows(s, out, OUT_HEADER);
  at = applyLog(s, out, at, out[6]!);
  s.serial = out[1]!;
  // Each live bullet's life, then its position; an expired one keeps its position.
  c.bullets?.slice(0, out[7]!).forEach(b => {
    if (!Object.is(b.life, out[at + 2])) b.life = out[at + 2]!;
    if (!Object.is(b.x, out[at])) b.x = out[at]!;
    if (!Object.is(b.y, out[at + 1])) b.y = out[at + 1]!;
    at += 3;
  });
  // A finished projectile run replaces the list, as the TypeScript's filter did, spent and expired bullets removed.
  if (c.mode === MODE_PROJECTILES && !out[2]) {
    const removed = new Set(Array.from({ length: out[8]! }, (_, i) => c.bullets![out[at + i]!]));
    s.projectiles = s.projectiles.filter(b => !removed.has(b));
  }
  return out[2] ? { target: players[out[3]!]!, source: out[4]! >= 0 ? players[out[4]!]! : null } : null;
}

/** Run a call to its end, eliminating at each stop and resuming. */
function drive(s: Game, c: Call): void {
  for (let stop = call(s, c); stop; stop = call(s, { ...c, resume: true })) {
    eliminateInCore(s, stop.target, stop.source);
    // One damage has nothing left after its elimination.
    if (c.mode === MODE_DAMAGE) return;
  }
}

/** Phase 5's projectiles: each swept against the actors' substep paths and the geometry, hits by time of impact. */
export function solvePhysicsProjectiles(s: Game, paths: Record<string, Vec2[]>): void {
  if (!s.projectiles.length) return;
  drive(s, { mode: MODE_PROJECTILES, resume: false, paths, bullets: s.projectiles });
}

/** Phase 5's end-of-tick casters, by stable caster ID: a warden's skill, then a gladiator's attack. */
export function castersInCore(s: Game, casters: readonly Caster[]): void {
  if (!casters.length) return;
  drive(s, { mode: MODE_CASTERS, resume: false, casters });
}

/** `damage`, and the elimination it may cause, in the core. */
export function damageInCore(s: Game, target: Player, amount: number, source: Player | null): void {
  drive(s, { mode: MODE_DAMAGE, resume: false, damage: { target, amount, source } });
}
