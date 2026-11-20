import { initCore, type CoreExports } from '../core.ts';
import { clearRoute } from './geometry.ts';
import { event, effect, participant } from './loot.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { RESPAWN_CLEARANCE_RADIUS, RESPAWN_CONTESTANT_DISTANCE, RESPAWN_HAZARD_MARGIN } from './rules.ts';
import { sightOf } from './sight-runtime.ts';
import { RAIL_COOLDOWN } from './transit.ts';
import type { Game, Player, PlayerStatus } from '../types.ts';

// The adapter for tick phase 1 in the core (`rust/core/src/phase_one.rs`, #1212, docs/27 "The state
// flip" step 4). The state stays here (D1): each tick packs what phase 1 reads, the core runs the tick,
// timer, respawn and arrival rules over it and allocates their serial IDs, and this unpacks the result.
// - **Facts the core reports** are applied here in allocation order: the event and the effect records,
//   and the Node-owned input bookkeeping and route of 27's change-list table.
// - **Both queries run in the core** (#1234): a respawn's station clearance and a transit's landing, over
//   the map's collision upload, the gate set and the physics world, so a tick is one call.
// - **Views are made after each call,** because a call may grow WASM memory.

/** The core's phase-1 exports (`rust/core/src/lib.rs`). */
interface PhaseOneExports {
  phase_one_new(): number;
  phase_one_input(phase: number, len: number): number;
  phase_one_run(phase: number, world: number, collision: number, gates: number): number;
}

// The layout of `phase_one.rs`.
const HEADER = 15, STATION_STRIDE = 2, PLAYER_STRIDE = 17;
const TICK = 0, HAZARD_X = 4, SERIAL = 5;
const ROLE = 0, STATUS = 1, RESPAWN_AT = 2, ARRIVE_AT = 3, X = 4, Y = 5, HP = 6, MAX_HP = 7, SHIELD = 8, TIMERS = 9, DESTINATION = 16;
const TIMER_KEYS = ['cooldown', 'attackCd', 'railCd', 'cloak', 'revealed', 'boost', 'stun'] as const;
const STATUS_CODES: readonly PlayerStatus[] = ['active', 'eliminated', 'respawning', 'escaped', 'stranded', 'transit'];
const RESPAWNED = 1;

let bound: { core: CoreExports & PhaseOneExports; phase: number } | undefined;
let loading: Promise<void> | undefined;
/** Binds phase 1 to the process's one core, once. `createGame` awaits it, so a tick never does. */
export const initPhaseOne = (): Promise<void> => loading ??= initCore().then(loaded => {
  const core = loaded as CoreExports & PhaseOneExports;
  bound = { core, phase: core.phase_one_new() >>> 0 };
});

const num = (value: number | null | undefined): number => value ?? NaN;
/** Writes a field the core returned, unless it is what was packed, so an absent field stays absent. */
function put<K extends 'x' | 'y' | 'hp' | 'shield' | typeof TIMER_KEYS[number]>(p: Player, key: K, value: number): void {
  if (!Object.is(num(p[key]), value)) p[key] = value;
}

/**
 * Phase 1 before physics synchronization: advance the tick, the hazard wall and the effects, then per player
 * in roster order respawn, arrive and count down an active player's timers (29.2).
 */
export function beginTick(s: Game): void {
  if (!bound) throw new Error('phase 1 is not bound to the core: await initPhaseOne() first');
  const runtime = physicsRuntime(s);
  if (!runtime) throw new Error('phase 1 needs the game\'s physics world');
  const { core, phase } = bound;
  const players = s.players, effects = s.effects, stations = s.map.stations, radii = s.content.actorPhysics.geometry;
  const stationBase = HEADER + effects.length, playerBase = stationBase + stations.length * STATION_STRIDE;
  const words = playerBase + players.length * PLAYER_STRIDE;
  // Only a respawn or an arrival reads the gates, so the mask is written only when a player could make one.
  const queries = players.some(p => p.status === 'respawning' || p.status === 'transit');
  const { world } = runtime.world.boundaryCall();
  const map = sightOf(s).queryHandles(s.map, queries);
  if (map.core !== core) throw new Error('phase 1 and sight are bound to different cores');
  const pointer = core.phase_one_input(phase, words) >>> 0;
  let input = new Float64Array(core.memory.buffer, pointer, words);
  input.set([s.tick, s.content.hazardGraceTicks, s.content.durationTicks, s.map.width, s.hazardX, s.serial, players.length,
    effects.length, stations.length, RESPAWN_HAZARD_MARGIN, RESPAWN_CONTESTANT_DISTANCE, RAIL_COOLDOWN,
    radii.contestant.bodyRadius, radii.gladiator.bodyRadius, RESPAWN_CLEARANCE_RADIUS]);
  for (let i = 0; i < effects.length; i++) input[HEADER + i] = effects[i]!.life;
  for (let i = 0, at = stationBase; i < stations.length; i++, at += STATION_STRIDE) {
    input[at] = stations[i]!.x; input[at + 1] = stations[i]!.y;
  }
  for (let i = 0, at = playerBase; i < players.length; i++, at += PLAYER_STRIDE) {
    const p = players[i]!;
    input[at + ROLE] = p.role === 'contestant' ? 0 : 1;
    input[at + STATUS] = STATUS_CODES.indexOf(p.status);
    input[at + RESPAWN_AT] = num(p.respawnAt);
    input[at + ARRIVE_AT] = num(p.transit?.arriveAt);
    input[at + X] = p.x; input[at + Y] = p.y; input[at + HP] = p.hp; input[at + MAX_HP] = p.maxHp; input[at + SHIELD] = p.shield;
    for (let t = 0; t < TIMER_KEYS.length; t++) input[at + TIMERS + t] = num(p[TIMER_KEYS[t]!]);
    input[at + DESTINATION] = p.transit ? stations.findIndex(st => st.id === p.transit!.to) : -1;
  }
  const out = core.phase_one_run(phase, world, map.collision, map.gates) >>> 0;
  input = new Float64Array(core.memory.buffer, pointer, words);
  const facts = new Float64Array(core.memory.buffer, out, 1)[0]!;
  const result = new Float64Array(core.memory.buffer, out + 8, facts * 3);
  s.tick = input[TICK]!; s.hazardX = input[HAZARD_X]!;
  for (let i = 0; i < effects.length; i++) effects[i]!.life = input[HEADER + i]!;
  s.effects = effects.filter(e => e.life > 0);
  for (let i = 0, at = playerBase; i < players.length; i++, at += PLAYER_STRIDE) {
    const p = players[i]!;
    p.movedThisTick = 0;
    const status = STATUS_CODES[input[at + STATUS]!];
    if (status && status !== p.status) p.status = status;
    put(p, 'x', input[at + X]!); put(p, 'y', input[at + Y]!); put(p, 'hp', input[at + HP]!); put(p, 'shield', input[at + SHIELD]!);
    for (let t = 0; t < TIMER_KEYS.length; t++) put(p, TIMER_KEYS[t]!, input[at + TIMERS + t]!);
  }
  // Facts in allocation order; the records keep their builders, which take the core's IDs. A builder reads the
  // serial it is given, so each fact's serial is set before its records are built.
  for (let f = 0; f < result.length; f += 3) {
    const p = players[result[f + 1]!]!;
    s.serial = result[f + 2]!;
    if (result[f] === RESPAWNED) {
      p.respawnAt = null; p.input = {}; p.inputTick = s.tick; clearRoute(p);
      event(s, { kind: 'respawned', actor: participant(s, p) });
    } else {
      delete p.transit; p.inputTick = s.tick;
      effect(s, p, 'rail', 60);
    }
  }
  s.serial = input[SERIAL]!;
}
