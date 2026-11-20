import { initCore, type CoreExports } from '../core.ts';
import { canOccupy } from '../movement.ts';
import { clearRoute } from './geometry.ts';
import { event, effect, participant } from './loot.ts';
import { RESPAWN_CLEARANCE_RADIUS, RESPAWN_CONTESTANT_DISTANCE, RESPAWN_HAZARD_MARGIN } from './rules.ts';
import { RAIL_COOLDOWN, landing } from './transit.ts';
import type { Game, Player, PlayerStatus } from '../types.ts';

// The adapter for tick phase 1 in the core (`rust/core/src/phase_one.rs`, #1212, docs/27 "The state
// flip" step 4). The state stays here (D1): each tick packs what phase 1 reads, the core runs the tick,
// timer, respawn and arrival rules over it and allocates their serial IDs, and this unpacks the result.
// - **Facts the core reports** are applied here in allocation order: the event and the effect records,
//   and the Node-owned input bookkeeping and route of 27's change-list table.
// - **Two queries stay here** (station clearance and the landing placement). The run stops before a player
//   that needs one; the players before it are applied, so the query reads them as the TypeScript tick did,
//   and the run resumes from that player.
// - **Views are made after each call,** because a call may grow WASM memory.

/** The core's phase-1 exports (`rust/core/src/lib.rs`). */
interface PhaseOneExports {
  phase_one_new(): number;
  phase_one_input(phase: number, len: number): number;
  phase_one_run(phase: number, from: number): number;
}

// The layout of `phase_one.rs`.
const HEADER = 18, STATION_STRIDE = 3, PLAYER_STRIDE = 16;
// The header is written whole below, in its order; these are the words read or answered after a run.
const TICK = 0, HAZARD_X = 4, SERIAL = 5, STATIONS_ANSWERED = 12, LANDING_ANSWERED = 13, LANDED = 14, LANDING_X = 15, LANDING_Y = 16;
const ROLE = 0, STATUS = 1, RESPAWN_AT = 2, ARRIVE_AT = 3, X = 4, Y = 5, HP = 6, MAX_HP = 7, SHIELD = 8, TIMERS = 9;
const TIMER_KEYS = ['cooldown', 'attackCd', 'railCd', 'cloak', 'revealed', 'boost', 'stun'] as const;
const STATUS_CODES: readonly PlayerStatus[] = ['active', 'eliminated', 'respawning', 'escaped', 'stranded', 'transit'];
const DONE = 0, NEED_STATIONS = 1, RESPAWNED = 1;

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
  const { core, phase } = bound;
  const players = s.players, effects = s.effects, stations = s.map.stations;
  const stationBase = HEADER + effects.length, playerBase = stationBase + stations.length * STATION_STRIDE;
  const words = playerBase + players.length * PLAYER_STRIDE;
  const pointer = core.phase_one_input(phase, words) >>> 0;
  // Made again after every core call, the run's and the queries' (the landing calls the physics core).
  const view = () => new Float64Array(core.memory.buffer, pointer, words);
  let input = view();
  input.set([s.tick, s.content.hazardGraceTicks, s.content.durationTicks, s.map.width, s.hazardX, s.serial, players.length,
    effects.length, stations.length, RESPAWN_HAZARD_MARGIN, RESPAWN_CONTESTANT_DISTANCE, RAIL_COOLDOWN, 0, 0, 0, 0, 0, 0]);
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
  }
  for (let from = 0, first = true; ;) {
    const out = core.phase_one_run(phase, from) >>> 0;
    input = view();
    const [state, stop, facts] = new Float64Array(core.memory.buffer, out, 3) as unknown as [number, number, number];
    const result = new Float64Array(core.memory.buffer, out + 24, facts * 3);
    if (first) {
      first = false;
      s.tick = input[TICK]!; s.hazardX = input[HAZARD_X]!;
      for (let i = 0; i < effects.length; i++) effects[i]!.life = input[HEADER + i]!;
      s.effects = effects.filter(e => e.life > 0);
    }
    const end = state === DONE ? players.length : stop;
    for (let i = from, at = playerBase + from * PLAYER_STRIDE; i < end; i++, at += PLAYER_STRIDE) {
      const p = players[i]!;
      p.movedThisTick = 0;
      const status = STATUS_CODES[input[at + STATUS]!];
      if (status && status !== p.status) p.status = status;
      put(p, 'x', input[at + X]!); put(p, 'y', input[at + Y]!); put(p, 'hp', input[at + HP]!); put(p, 'shield', input[at + SHIELD]!);
      for (let t = 0; t < TIMER_KEYS.length; t++) put(p, TIMER_KEYS[t]!, input[at + TIMERS + t]!);
    }
    // Facts in allocation order; the records keep their builders, which take the core's IDs.
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
    if (state === DONE) return;
    if (state === NEED_STATIONS) {
      const clear = stations.map(st => canOccupy(s.map, st.x, st.y, RESPAWN_CLEARANCE_RADIUS));
      input = view();
      input[STATIONS_ANSWERED] = 1;
      for (let i = 0; i < stations.length; i++) input[stationBase + i * STATION_STRIDE + 2] = clear[i] ? 1 : 0;
    } else {
      const p = players[stop]!, to = s.map.stations.find(st => st.id === p.transit!.to)!, at = landing(s, p, to);
      input = view();
      input[LANDING_ANSWERED] = 1; input[LANDED] = at ? 1 : 0;
      if (at) { input[LANDING_X] = at.x; input[LANDING_Y] = at.y; }
    }
    from = stop;
  }
}
