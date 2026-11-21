import { KITS, PLAYER_STATUSES } from '../enum-tables.ts';
import type { CoreExports } from '../core.ts';
import type { Game, Player } from '../types.ts';

// The core's player store (`rust/core/src/players.rs`, #1214, docs/27 "The state flip", step 6c). The runs converted
// so far, phase 5's combat and phase 6's environment and traps, read the players from it rather than from rows of their
// own. The other phases still write the player records directly, so the store is uploaded from the records before each
// converted call. When the last of those writers converts, the upload happens once a tick, at its start.

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
/** Words per player uploaded (`players::STORE_ROW`): the fields, then `movedThisTick`. */
const STORE_ROW = PLAYER_ROW + 1;

/** Write a player's fields (`combat::Row`) at `at`; returns where they end. */
function putPlayerRow(data: Float64Array, at: number, p: Player, rank: number): number {
  data[at] = p.role === 'contestant' ? 0 : 1; data[at + 1] = PLAYER_STATUSES.indexOf(p.status); data[at + 2] = KITS.indexOf(p.kit);
  data[at + 3] = p.x; data[at + 4] = p.y; data[at + 5] = p.heading; data[at + 6] = p.hp; data[at + 7] = p.maxHp; data[at + 8] = p.shield;
  data[at + 9] = p.level; data[at + 10] = p.cooldown; data[at + 11] = p.attackCd; data[at + 12] = p.stun; data[at + 13] = rank;
  data[at + 14] = p.viewLagTicks ?? 0;
  return at + PLAYER_ROW;
}

/** Upload every player to the world's store, in roster order. Call it before any other input of the call is viewed. */
export function uploadPlayers(s: Game, core: StoreExports, world: number): void {
  const players = s.players, ranks = idRanks(s);
  const data = new Float64Array(core.memory.buffer, core.players_input(world, players.length) >>> 0, players.length * STORE_ROW);
  for (let i = 0, at = 0; i < players.length; i++) {
    const p = players[i]!;
    at = putPlayerRow(data, at, p, ranks[i]!);
    data[at++] = p.movedThisTick ?? 0;
  }
  core.players_load(world, players.length);
}
