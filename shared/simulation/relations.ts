import type { Game, GateIdx, Player, PlayerId, PlayerIdx } from '../types.ts';

interface RosterIndex {
  byId: Map<PlayerId, PlayerIdx>;
  byPlayer: WeakMap<Player, PlayerIdx>;
}
const rosters = new WeakMap<readonly Player[], RosterIndex>();

/** Dense match slots are private substrate; legacy IDs remain at the CP1 boundary. */
export function indexRoster(players: readonly Player[], rebuild = false): RosterIndex {
  let index = rosters.get(players);
  if (index && !rebuild) return index;
  index = { byId: new Map(), byPlayer: new WeakMap() };
  players.forEach((p, i) => {
    const idx = i as PlayerIdx;
    // Match rosters have unique IDs. Preserve first-match behavior for diagnostic records as well.
    if (!index!.byId.has(p.id)) index!.byId.set(p.id, idx);
    index!.byPlayer.set(p, idx);
  });
  rosters.set(players, index);
  return index;
}
export function playerIndex(s: Pick<Game, 'players'>, p: Player): PlayerIdx {
  const idx = indexRoster(s.players).byPlayer.get(p);
  if (idx === undefined) throw new RangeError('player is outside the match roster');
  return idx;
}
export function playerById(s: Pick<Game, 'players'>, id: PlayerId | string): Player | undefined {
  let idx = indexRoster(s.players).byId.get(id as PlayerId);
  // Seat commands refresh explicitly. This guard also supports diagnostic ID assignments and
  // hand-built records without changing Player's enumerable legacy shape.
  if (idx === undefined || s.players[idx]?.id !== id)
    idx = indexRoster(s.players, true).byId.get(id as PlayerId);
  return idx === undefined ? undefined : s.players[idx];
}
/** Canonical gate identity is its map slot, even while CP1 preserves legacy world admission order. */
export const gateAt = (s: Game, idx: GateIdx) => s.map.gates[idx];
