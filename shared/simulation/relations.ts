import type { Game, GateIdx, Player, PlayerId, PlayerIdx } from '../types.ts';

interface RosterIndex {
  byId: Map<PlayerId, PlayerIdx>;
}
const rosters = new WeakMap<readonly Player[], RosterIndex>();

/** Dense match slots are private substrate; legacy IDs remain at the CP1 boundary. */
export function indexRoster(players: readonly Player[], rebuild = false): RosterIndex {
  let index = rosters.get(players);
  if (index && !rebuild && index.byId.size === players.length) return index;
  index = { byId: new Map() };
  players.forEach((p, i) => {
    const idx = i as PlayerIdx;
    if (!index!.byId.has(p.id)) index!.byId.set(p.id, idx);
  });
  rosters.set(players, index);
  return index;
}
export function playerById(s: Pick<Game, 'players'>, id: PlayerId | string): Player | undefined {
  const index = indexRoster(s.players);
  let idx = index.byId.get(id as PlayerId);
  // Seat commands refresh explicitly. This guard also supports diagnostic ID assignments and
  // hand-built records without changing Player's enumerable legacy shape.
  if (idx !== undefined && s.players[idx]?.id !== id)
    idx = indexRoster(s.players, true).byId.get(id as PlayerId);
  else if (idx === undefined) {
    // A true miss (spectator, trap owner, unknown session) never rebuilds the cache.
    // Only an actual player inserted/renamed by diagnostic setup needs a refresh.
    const found = s.players.find(p => p.id === id);
    if (!found) return undefined;
    idx = indexRoster(s.players, true).byId.get(id as PlayerId);
  }
  return idx === undefined ? undefined : s.players[idx];
}
/** Canonical gate identity is its map slot, even while CP1 preserves legacy world admission order. */
export const gateAt = (s: Pick<Game, 'map'>, idx: GateIdx) => s.map.gates[idx];
