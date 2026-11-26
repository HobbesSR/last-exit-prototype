import { heardBy } from './hearing.ts';
import { playerSlot } from './relations.ts';
import type { Game, GroundItem, HeardCue, PlayerId, PlayerIdx, Tick } from '../types.ts';

// What `projectView` reads besides the frame (docs/27.2 "Projection and knowledge (#1343, #1352)"): which roster place a
// viewer holds, what it has discovered and the cues it hears. For a started game every answer is the core's output: the
// seats are `MatchIds`, the knowledge is the cache beside the frame store (`TickKnowledge`), and the ground's grid follows
// the frame store's lists. Only an unstarted game, which a test arranges, is read from its players.

/** A viewer's knowledge that frames do not carry, by roster place. */
export interface ViewKnowledge {
  /** The discovery cells a contestant has discovered, or null when it keeps no memory. */
  discovered(slot: PlayerIdx): ReadonlySet<number> | null;
  /** The cues a player hears that last past `tick`. */
  heard(slot: PlayerIdx, tick: Tick): readonly HeardCue[];
}

export interface ViewSource {
  /** The roster place a player ID holds now, or undefined for a non-player viewer. */
  slotOf(id: PlayerId): PlayerIdx | undefined;
  knowledge: ViewKnowledge;
  /** The ground list `framedItems` may use the item grid of, besides a frame store's: the unstarted game's own. */
  ground?: readonly GroundItem[] | undefined;
}

const sources = new WeakMap<Game, ViewSource>();

/** A started game's session registers its source (`createTickSession`). */
export function registerViewSource(s: Game, source: ViewSource): void { sources.set(s, source); }

/**
 * The source a game is projected from: its session's once started, else its players as arranged. For tests and tools
 * that hold a `Game`; the server passes its session's source to `projectView` itself.
 */
export function viewSourceOf(s: Game): ViewSource {
  return sources.get(s) ?? {
    slotOf: id => playerSlot(s, id),
    knowledge: {
      discovered: slot => s.players[slot]?.discovery?.discovered ?? null,
      heard: (slot, tick) => { const p = s.players[slot]; return p ? heardBy(p, tick) : []; },
    },
    ground: s.items,
  };
}
