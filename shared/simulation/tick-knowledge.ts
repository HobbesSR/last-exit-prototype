import { start as profileStart, stop as profileStop } from '../profiler.ts';
import { attachDiscovery } from '../discovery.ts';
import { ItemMemory, SeenCells } from './bot-memory.ts';
import { groundOf } from './tick-records.ts';
import type { Context } from './tick-records.ts';
import type { Cue, DecodedTick, Memory } from './tick-codec.ts';
import type { TickMatch } from './tick-match.ts';
import type { DiscoveryMemory, Game, HeardCue, Player } from '../types.ts';

// What each player knows and hears, written onto the `Game` players for `playerView` (docs/27.2 "Node adapter (3d.2)"):
// a contestant's discovery memory and every player's heard cues, read from the match after each completed tick. It is the
// one part of the mirror that projection still reads, until the core projects each viewer itself (#1343). Every started
// game keeps it; the record applier (`tick-mirror.ts`) runs only for a room (#1345).

export const heardOf = (cue: Cue): HeardCue => ({ x: cue.at[0], y: cue.at[1], tick: cue.tick, until: cue.until });

/** An empty memory in the bots' own structures (`bot-memory.ts`), which keep the frontier and the loot grid. */
export function emptyMemory(ctx: Context): DiscoveryMemory {
  return { discovered: new Set(), seen: new SeenCells(ctx.grid.cols, ctx.grid.rows), surveyed: new Set(), items: new ItemMemory(),
    gates: new Map(), revision: 0 };
}

/**
 * Write the core's memory into a contestant's. The revision counts only what plans read (cells discovered, surveyed
 * cells, doors), as `discover` counts it, so a sample that only sees cells or loot leaves it, and every sample is written.
 * Cells are only ever learned, so they are added; remembered items and doors
 * are set under their keys and a forgotten item deleted. Adding and setting keep what a bot met first first, as its ties
 * expect until #1215 (R11).
 */
export function writeMemory(ctx: Context, d: DiscoveryMemory, m: Memory): DiscoveryMemory {
  for (const cell of m.discovered) d.discovered.add(cell);
  for (const cell of m.seen) d.seen!.add(cell);
  for (const cell of m.surveyed) d.surveyed!.add(cell);
  const items = d.items!, kept = new Set(m.items.map(r => r.id));
  for (const id of items.keys()) if (!kept.has(id)) items.delete(id);
  for (const r of m.items) items.set(r.id as never, groundOf(ctx, r.id, r.item, r.at));
  for (const g of m.gates) d.gates!.set(ctx.ids.gateIds[g.gate]!, { open: g.open, locked: g.locked });
  d.revision = m.revision;
  return d;
}

/** The knowledge writer of one match. Construct it on the game the match was set up from, before the first step. */
export class TickKnowledge {
  readonly s: Game;
  readonly match: TickMatch;
  readonly ctx: Context;

  constructor(s: Game, match: TickMatch, ctx: Context) {
    this.s = s; this.match = match; this.ctx = ctx;
    for (const p of s.players) this.#memory(p, true);
  }

  /** Refresh a contestant's memory from the match; `fresh` starts it over, as at the start, where the core's holds nothing yet. */
  #memory(p: Player, fresh = false): void {
    if (p.role !== 'contestant' || !this.ctx.discovery) return;
    profileStart('sim.tick.memory');
    try {
      const memory = this.match.memory(p.id);
      if (!memory) return;
      if (fresh || !p.discovery) attachDiscovery(p, emptyMemory(this.ctx));
      writeMemory(this.ctx, p.discovery!, memory);
    } finally { profileStop('sim.tick.memory'); }
  }

  /** After a completed tick: the memory of each contestant the tick's discovery names, and every player's cues. */
  apply(t: DecodedTick): void {
    const ids = this.ctx.ids;
    const learned = new Set([...t.discovery.gates.map(g => g.actor), ...t.discovery.samples.map(x => x.actor)]);
    for (const p of this.s.players) {
      const word = ids.actorOfPlayer.get(p.id)!;
      if (learned.has(word)) this.#memory(p);
      const cues = this.match.heard(p.id);
      if (cues.length || p.heard?.length) {
        if (!p.heard) Object.defineProperty(p, 'heard', { value: [], writable: true, configurable: true, enumerable: false });
        p.heard = cues.map(heardOf);
      }
    }
  }
}
