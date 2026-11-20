import type { CoreSight } from '../sight-core.ts';
import type { Game } from '../types.ts';

// Which sight a stepping game casts with, beside its physics world (`physics-runtime.ts`): an engine the
// game runs on, kept off the record so snapshots and replays never carry it. `createGame` attaches it.
const games = new WeakMap<Game, CoreSight>();

export function attachSight(s: Game, sight: CoreSight): void {
  if (games.has(s)) throw new Error('sight already attached');
  games.set(s, sight);
}

/** The game's sight; only a game built by `createGame` has one, as only such a game steps. */
export function sightOf(s: Game): CoreSight {
  const sight = games.get(s);
  if (!sight) throw new Error('this game has no sight: only a game built with createGame casts sight');
  return sight;
}
