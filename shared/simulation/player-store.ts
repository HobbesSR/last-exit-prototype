import { KITS, PLAYER_STATUSES } from '../enum-tables.ts';
import type { CoreExports } from '../core.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, Player } from '../types.ts';

// The core's player store (`rust/core/src/players.rs`, #1214, docs/27 "The state flip", step 6c). Phase 1 (6c.2),
// phase 5's combat and phase 6's environment and traps (6c.1) read the players from it rather than from rows of their
// own. Every write to its fields inside a tick reaches it too (6c.2): the core's runs write it as they report their
// writes, and phase 4's poses are written from the step (`players_after_step`). So it is uploaded once a tick, by phase
// 1, and before a converted call between ticks, where tests, tools and the between-tick commands write the records.

type StoreExports = Pick<CoreExports, 'memory' | 'players_input' | 'players_load'>;

/** Each player's rank in ID order, which is `ordered(s)`'s. */
export function idRanks(s: Game): number[] {
  const players = s.players, ranks = new Array<number>(players.length);
  players.map((_, i) => i).sort((a, b) => players[a]!.id < players[b]!.id ? -1 : players[a]!.id > players[b]!.id ? 1 : 0)
    .forEach((idx, rank) => { ranks[idx] = rank; });
  return ranks;
}

/** Words in a player's fields (`combat::PLAYER_ROW`). */
export const PLAYER_ROW = 15;
/** Words per player uploaded (`players::STORE_ROW`): the fields, `movedThisTick`, then `players::Extra`. */
const STORE_ROW = PLAYER_ROW + 1 + 8;
const num = (value: number | null | undefined): number => value ?? NaN;

/** Write a player's fields (`combat::Row`) at `at`; returns where they end. */
function putPlayerRow(data: Float64Array, at: number, p: Player, rank: number): number {
  data[at] = p.role === 'contestant' ? 0 : 1; data[at + 1] = PLAYER_STATUSES.indexOf(p.status); data[at + 2] = KITS.indexOf(p.kit);
  data[at + 3] = p.x; data[at + 4] = p.y; data[at + 5] = p.heading; data[at + 6] = p.hp; data[at + 7] = p.maxHp; data[at + 8] = p.shield;
  data[at + 9] = p.level; data[at + 10] = p.cooldown; data[at + 11] = p.attackCd; data[at + 12] = p.stun; data[at + 13] = rank;
  data[at + 14] = p.viewLagTicks ?? 0;
  return at + PLAYER_ROW;
}

/** Whether a converted call must upload first: only between ticks, since inside one every write reaches the store. */
export const playersStale = (r: PhysicsRuntime): boolean => !r.stepping;

/** Pack every player in the upload's layout into `data`, in roster order. */
function packPlayers(s: Game, keys: readonly number[], data: Float64Array): void {
  const players = s.players, ranks = idRanks(s), stations = s.map.stations;
  for (let i = 0, at = 0; i < players.length; i++) {
    const p = players[i]!;
    at = putPlayerRow(data, at, p, ranks[i]!);
    data[at++] = p.movedThisTick ?? 0;
    // `players::Extra`, as phase 1 packed it before stage 6c.2.
    data[at++] = num(p.respawnAt); data[at++] = num(p.transit?.arriveAt);
    data[at++] = p.transit ? stations.findIndex(st => st.id === p.transit!.to) : -1;
    data[at++] = num(p.railCd); data[at++] = num(p.cloak); data[at++] = num(p.revealed); data[at++] = num(p.boost);
    data[at++] = keys[i]!;
  }
}

/**
 * Where the core's store differs from a fresh upload of the records, as `player.field: store != record` lines; empty when
 * they agree. For tests: after a tick, every write must have reached both.
 */
export function storeDrift(s: Game, r: PhysicsRuntime): string[] {
  const { core, world } = r.world.boundaryCall();
  const keys = s.players.map(p => r.world.key(`actor:${p.id}`));
  const fresh = new Float64Array(s.players.length * STORE_ROW);
  packPlayers(s, keys, fresh);
  if (core.players_count(world) !== s.players.length) return [`the store holds ${core.players_count(world)} players, the roster ${s.players.length}`];
  const kept = new Float64Array(core.memory.buffer, core.players_dump(world) >>> 0, fresh.length);
  const out: string[] = [];
  for (let k = 0; k < fresh.length; k++) if (!Object.is(kept[k], fresh[k]))
    out.push(`${s.players[Math.floor(k / STORE_ROW)]!.id}.${FIELDS[k % STORE_ROW]}: ${kept[k]} != ${fresh[k]}`);
  return out;
}
const FIELDS = ['role', 'status', 'kit', 'x', 'y', 'heading', 'hp', 'maxHp', 'shield', 'level', 'cooldown', 'attackCd', 'stun', 'rank',
  'viewLagTicks', 'movedThisTick', 'respawnAt', 'arriveAt', 'destination', 'railCd', 'cloak', 'revealed', 'boost', 'key'];

/**
 * Upload every player to the world's store, in roster order. Call it before any other input of the call is viewed: the
 * actors' world keys are interned first, which can grow the memory.
 */
export function uploadPlayers(s: Game, r: PhysicsRuntime, core: StoreExports, world: number): void {
  const players = s.players;
  const keys = players.map(p => r.world.key(`actor:${p.id}`));
  packPlayers(s, keys, new Float64Array(core.memory.buffer, core.players_input(world, players.length) >>> 0, players.length * STORE_ROW));
  core.players_load(world, players.length);
}
