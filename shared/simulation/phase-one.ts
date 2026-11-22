import { initCore, type CoreExports } from '../core.ts';
import { clearRoute } from './geometry.ts';
import { event, effect, participant } from './event-records.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { uploadPlayers } from './player-store.ts';
import { RESPAWN_CLEARANCE_RADIUS, RESPAWN_CONTESTANT_DISTANCE, RESPAWN_HAZARD_MARGIN } from './rules.ts';
import { sightOf } from './sight-runtime.ts';
import { RAIL_COOLDOWN } from './transit.ts';
import type { Game, Player, PlayerStatus } from '../types.ts';

// The adapter for tick phase 1 in the core (`rust/core/src/phase_one.rs`, #1212, docs/27 "The state
// flip" step 4). Each tick packs what phase 1 reads, apart from the players, which the core fills from its player
// store (`player-store.ts`, #1214 stage 6c.2); the core runs the tick, timer, respawn and arrival rules over it and
// allocates their serial IDs, and this unpacks the result from the same buffer.
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
const STATUS = 1, X = 4, Y = 5, HP = 6, SHIELD = 8, TIMERS = 9;
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
  const runtime = physicsRuntime(s);
  if (!runtime) throw new Error('phase 1 needs the game\'s physics world');
  const { core, phase, words } = packPhaseOne(s);
  const map = sightOf(s).queryHandles(s.map);
  const { world } = runtime.world.boundaryCall();
  const out = core.phase_one_run(phase, world, map.collision, map.gates) >>> 0;
  const state = new Float64Array(core.memory.buffer, core.phase_one_input(phase, words) >>> 0, words).slice();
  const facts = new Float64Array(core.memory.buffer, out, 1)[0]!;
  applyPhaseOne(s, state, new Float64Array(core.memory.buffer, out + 8, facts * 3).slice());
}

/**
 * Write phase 1's input for this tick (the players are uploaded to the store first); `tick_begin` runs it in its call
 * (#1214 stage 6e.5). Returns the bound core, phase 1's handle and the input's length.
 */
export function packPhaseOne(s: Game): { core: CoreExports & PhaseOneExports; phase: number; words: number } {
  if (!bound) throw new Error('phase 1 is not bound to the core: await initPhaseOne() first');
  const runtime = physicsRuntime(s);
  if (!runtime) throw new Error('phase 1 needs the game\'s physics world');
  const { core, phase } = bound;
  const players = s.players, effects = s.effects, stations = s.map.stations, radii = s.content.actorPhysics.geometry;
  const stationBase = HEADER + effects.length, playerBase = stationBase + stations.length * STATION_STRIDE;
  const words = playerBase + players.length * PLAYER_STRIDE;
  const { world } = runtime.world.boundaryCall();
  uploadPlayers(s, runtime, core, world);
  const map = sightOf(s).queryHandles(s.map);
  if (map.core !== core) throw new Error('phase 1 and sight are bound to different cores');
  const pointer = core.phase_one_input(phase, words) >>> 0;
  const input = new Float64Array(core.memory.buffer, pointer, words);
  input.set([s.tick, s.content.hazardGraceTicks, s.content.durationTicks, s.map.width, s.hazardX, s.serial, players.length,
    effects.length, stations.length, RESPAWN_HAZARD_MARGIN, RESPAWN_CONTESTANT_DISTANCE, RAIL_COOLDOWN,
    radii.contestant.bodyRadius, radii.gladiator.bodyRadius, RESPAWN_CLEARANCE_RADIUS]);
  for (let i = 0; i < effects.length; i++) input[HEADER + i] = effects[i]!.life;
  for (let i = 0, at = stationBase; i < stations.length; i++, at += STATION_STRIDE) {
    input[at] = stations[i]!.x; input[at + 1] = stations[i]!.y;
  }
  return { core, phase, words };
}

/** Apply phase 1's run: `input` as the run left its input, `result` its facts (three words each). */
export function applyPhaseOne(s: Game, input: Float64Array, result: Float64Array): void {
  const players = s.players, effects = s.effects, stations = s.map.stations;
  const stationBase = HEADER + effects.length, playerBase = stationBase + stations.length * STATION_STRIDE;
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
