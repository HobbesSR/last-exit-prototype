import { start as profileStart, stop as profileStop } from '../profiler.ts';
import type { Context } from './tick-records.ts';
import type { Cue, DecodedTick } from './tick-codec.ts';
import type { TickMatch } from './tick-match.ts';
import type { ViewKnowledge } from './view-source.ts';
import type { Game, HeardCue, PlayerIdx, Tick } from '../types.ts';

// The knowledge cache beside the frame store (docs/27.2 "Projection and knowledge (#1343, #1352)"): what projection needs
// of each player's knowledge that frames do not carry, by roster place. The core keeps the whole memory and the cues, which
// its rules and bots read. The cache keeps only the wire's subset: each contestant's discovered cells and each player's
// live cues. A started game's `Game` players hold neither (#1343).
//
// - A contestant's cells are refreshed only when a tick's discovery names it.
// - A player's cues are queried only while it holds a live one, or when T's facts say it heard something.

export const heardOf = (cue: Cue): HeardCue => ({ x: cue.at[0], y: cue.at[1], tick: cue.tick, until: cue.until });

/** The knowledge cache of one match. Construct it on the game the match was set up from, before the first step. */
export class TickKnowledge implements ViewKnowledge {
  readonly s: Game;
  readonly match: TickMatch;
  readonly ctx: Context;
  /**
   * Each remembering contestant's discovered cells, by roster place, in the order they were learned: cells are only ever
   * learned, so a refresh adds, and the projected list keeps its order across ticks.
   */
  readonly #discovered = new Map<number, Set<number>>();
  /** Each player's cues as of the last query, by roster place; absent once none is live. */
  readonly #heard = new Map<number, HeardCue[]>();

  constructor(s: Game, match: TickMatch, ctx: Context) {
    this.s = s; this.match = match; this.ctx = ctx;
    // From here on the core's memory is the knowledge; the game's setup copies would only go stale.
    for (const p of s.players) { delete p.discovery; delete p.heard; }
    for (let slot = 0; slot < s.players.length; slot++) this.#memory(slot);
  }

  /** Refresh a contestant's cells from the match. */
  #memory(slot: number): void {
    if (this.s.players[slot]!.role !== 'contestant' || !this.ctx.discovery) return;
    profileStart('sim.tick.memory');
    try {
      const memory = this.match.memory(this.#id(slot));
      if (!memory) return;
      let cells = this.#discovered.get(slot);
      if (!cells) this.#discovered.set(slot, cells = new Set());
      for (const cell of memory.discovered) cells.add(cell);
    } finally { profileStop('sim.tick.memory'); }
  }

  #id(slot: number) { return this.ctx.ids.playerOfActor.get(this.ctx.ids.actorAtSlot[slot]!)!; }

  /** After a completed tick: the cells of each contestant the tick's discovery names, and the cues that can have changed. */
  apply(t: DecodedTick): void {
    const slots = this.ctx.ids.slotOfActor;
    for (const word of new Set([...t.discovery.gates.map(g => g.actor), ...t.discovery.samples.map(x => x.actor)])) {
      this.#memory(slots.get(word)!);
    }
    const hearing = new Set<number>();
    for (const e of t.changes.events) if (e.fact.kind === 'heard') hearing.add(slots.get(e.fact.listener)!);
    for (const [slot, cues] of this.#heard) if (cues.some(cue => cue.until > t.tick)) hearing.add(slot);
    for (const slot of this.#heard.keys()) if (!hearing.has(slot)) this.#heard.delete(slot);
    for (const slot of hearing) {
      const cues = this.match.heard(this.#id(slot)).map(heardOf);
      if (cues.length) this.#heard.set(slot, cues); else this.#heard.delete(slot);
    }
  }

  discovered(slot: PlayerIdx): ReadonlySet<number> | null { return this.#discovered.get(slot) ?? null; }
  heard(slot: PlayerIdx, tick: Tick): readonly HeardCue[] { return this.#heard.get(slot)?.filter(cue => cue.until > tick) ?? []; }
}
