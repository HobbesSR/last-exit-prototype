import type { Game, GateIdx, Player, PlayerId, PlayerIdx } from '../types.ts';

interface RosterIndex {
  byId: Map<PlayerId, PlayerIdx>;
  byPlayer: WeakMap<Player, PlayerIdx>;
}
const rosters = new WeakMap<readonly Player[], RosterIndex>();

/** Dense match slots are private substrate; legacy IDs remain at the CP1 boundary. */
export function indexRoster(players: readonly Player[], rebuild = false): RosterIndex {
  let index = rosters.get(players);
  if (index && !rebuild && index.byId.size === players.length) return index;
  index = { byId: new Map(), byPlayer: new WeakMap() };
  players.forEach((p, i) => {
    const idx = i as PlayerIdx;
    index!.byPlayer.set(p, idx);
    if (!index!.byId.has(p.id)) index!.byId.set(p.id, idx);
  });
  rosters.set(players, index);
  return index;
}
export function playerSlot(s: Pick<Game, 'players'>, id: PlayerId | string): PlayerIdx | undefined {
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
  return idx;
}
/** Canonical gate identity is its map slot, even while CP1 preserves legacy world admission order. */
export const gateAt = (s: Pick<Game, 'map'>, idx: GateIdx) => s.map.gates[idx];

/** Object-to-slot association: metadata/session labels never participate in internal relations. */
export function playerIndex(s: Pick<Game, 'players'>, player: Player): PlayerIdx {
  let idx = indexRoster(s.players).byPlayer.get(player);
  if (idx === undefined || s.players[idx] !== player)
    idx = indexRoster(s.players, true).byPlayer.get(player);
  if (idx === undefined) throw new RangeError('player is not in this roster');
  return idx;
}
/** Resolve a legacy label at the boundary; internal relations retain the slot itself. */
export function playerById(s: Pick<Game, 'players'>, id: PlayerId | string): Player | undefined {
  const idx = playerSlot(s, id);
  return idx === undefined ? undefined : s.players[idx];
}

const capturedSeats = new WeakMap<object, ReturnType<typeof copySeats>>();
function copySeats(s: { players: readonly Pick<Player, 'id' | 'name' | 'role' | 'kit' | 'seat'>[] }) {
  return s.players.map((p, i) => ({ playerIdx: i as PlayerIdx, id: p.id, name: p.name, role: p.role, kit: p.kit,
    ...(p.seat !== undefined ? { seat: p.seat } : {}) }));
}

/** Public seat labels are sent out of band; callers may supply a historical captured roster. */
export function seatMetadata(s: { players: readonly Pick<Player, 'id' | 'name' | 'role' | 'kit' | 'seat'>[] }) {
  // Games and waiting yards are mutable; only detached captured frames may be cached.
  if ('map' in s) return copySeats(s);
  let result = capturedSeats.get(s);
  if (!result) capturedSeats.set(s, result = copySeats(s));
  return result;
}
