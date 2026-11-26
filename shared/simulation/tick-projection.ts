import { start, stop } from '../profiler.ts';
import { EFFECT_KINDS, bodyKey } from './tick-codec.ts';
import { POTENTIAL, assembleView, readFrame, viewerOf, type ReadFrame, type ViewDecision } from './visibility.ts';
import { wireIds, type WireIds } from './wire-ids.ts';
import type { Admission, Cue } from './tick-codec.ts';
import type { TickFrames } from './tick-frame.ts';
import type { TickMatch } from './tick-match.ts';
import type { Game, HeardCue, PlayerId, PlayerIdx, Snapshot, Tick } from '../types.ts';

// The core's projection (docs/27.2 "Projection and knowledge", #1357, boundary C). The core decides what each player viewer
// may receive at the last completed tick, in one call for every viewer (`TickMatch.admit`). The room host assembles the view
// from the frame store's records, through the closed field contracts, with `assembleView`, as the TypeScript rules'
// decision is assembled. Only index lists and the viewer's knowledge cross.
//
// - **Discovery** arrives as the cells learned since those held here, so a viewer's list is appended to, in the order
//   learned, and the crossing follows what changed.
// - **A frame of another tick** is not decided here: `project` answers undefined and the caller projects by the rules.
// - **Knowledge** is the core's alone (#1357 stage 2). A viewer's cells and cues held here are what the core last sent; the
//   rules path reads them through `discovered` and `heard`, which ask the core first while the match is live, so no cache
//   of the match's memory is kept in Node.
// - **A decision holds** for one tick, one stranded state and a live match (`#current`). A room's finish strands its
//   contestants and broadcasts again within the tick, so the stranded state is part of it (review 1132).

/** Where each record sits in a list, by ID, kept per list so every viewer of a frame shares it. */
const positions = new WeakMap<readonly object[], Map<number, number>>();
function positionsOf<T extends { id: number }>(list: readonly T[]): Map<number, number> {
  let index = positions.get(list);
  if (!index) { index = new Map(list.map((record, i) => [record.id, i])); positions.set(list, index); }
  return index;
}
/** The records of `list` with these IDs, in the list's order. An ID the list lacks is a disagreement, never skipped. */
function picked<T extends { id: number }>(list: readonly T[], ids: Iterable<number>, what: string): T[] {
  const index = positionsOf(list), at: number[] = [];
  for (const id of ids) {
    const i = index.get(id);
    if (i === undefined) throw new RangeError(`tick-projection: the core admitted ${what} ${id}, which the frame does not hold`);
    at.push(i);
  }
  return at.sort((a, b) => a - b).map(i => list[i]!);
}

/** A cue as frames carry it. */
export const heardOf = (cue: Cue): HeardCue => ({ x: cue.at[0], y: cue.at[1], tick: cue.tick, until: cue.until });

/** The projection of one started match from the core's decisions. Construct it after the frame store, before the first step. */
export class TickProjection {
  readonly #match: TickMatch;
  readonly #frames: TickFrames;
  /** Each viewer's discovered cells in the order learned, by roster place: what the core has sent. */
  readonly #discovered = new Map<PlayerIdx, number[]>();
  /** Each viewer's cues as the core last sent them, by roster place. */
  readonly #heard = new Map<PlayerIdx, readonly HeardCue[]>();
  /** The decisions made at `#made`, by roster place. */
  readonly #decided = new Map<PlayerIdx, Admission>();
  /** What the decisions were made under: the tick and whether the room had stranded its contestants. */
  #made = { tick: -1, stranded: false };
  /** The core's last completed tick. Frames a test takes by hand can run ahead of it; those are the rules' to project. */
  #stepped: Tick;

  constructor(s: Game, match: TickMatch, frames: TickFrames) {
    this.#match = match; this.#frames = frames; this.#stepped = frames.tick;
    match.follow(t => { this.#stepped = t.tick; });
    // From here on the core's memory is the knowledge; the game's setup copies would only go stale.
    for (const p of s.players) { delete p.discovery; delete p.heard; }
    // An actor without a body at the start stands where the game put it, as the frame store takes it.
    const posed = new Set(match.snapshot().poses.flatMap(p => p.body.kind === 'actor' ? [p.body.id] : []));
    s.players.forEach((p, slot) => { const word = match.ids.actorAtSlot[slot]!; if (!posed.has(word)) match.stand(word, p.x, p.y); });
    // Effects a scenario arranged, in the frame's order, drawn for their `life` from the start as the frames draw them, so
    // the core's effect indices are the frame's (review 1132).
    for (const e of s.effects) match.arrangeEffect(EFFECT_KINDS.indexOf(e.kind as typeof EFFECT_KINDS[number]), e.x, e.y, e.radius, frames.tick + e.life);
  }

  /** Whether the decisions held answer for the frames' last tick as the room has left it, the match still live. */
  #current(): boolean {
    return !this.#match.disposed && this.#made.tick === this.#frames.tick && this.#made.stranded === this.#frames.stranded;
  }

  #slotOf(id: PlayerId): PlayerIdx | undefined {
    const word = this.#match.ids.actorOfPlayer.get(id);
    return word === undefined ? undefined : this.#match.ids.slotOfActor.get(word);
  }

  /** Ask the core, in one call, what these player viewers may receive at the last completed tick. */
  decide(ids: Iterable<PlayerId>): void {
    if (this.#match.disposed || this.#stepped !== this.#frames.tick) return;
    const tick: Tick = this.#frames.tick, stranded = this.#frames.stranded;
    if (!this.#current()) { this.#decided.clear(); this.#made = { tick, stranded }; }
    const viewers: { id: PlayerId; held: number }[] = [];
    for (const id of ids) {
      const slot = this.#slotOf(id);
      if (slot !== undefined && !this.#decided.has(slot) && !viewers.some(v => v.id === id))
        viewers.push({ id, held: this.#discovered.get(slot)?.length ?? 0 });
    }
    if (!viewers.length) return;
    start('sim.admit');
    try {
      const { tick: decided, admissions } = this.#match.admit(viewers, POTENTIAL, stranded);
      if (decided !== tick) throw new RangeError(`tick-projection: the core decided tick ${decided}, the frames hold ${tick}`);
      for (const admission of admissions) {
        const slot = this.#match.ids.slotOfActor.get(admission.actor)!;
        this.#decided.set(slot, admission);
        this.#heard.set(slot, admission.heard.map(heardOf));
        if (admission.total < 0) continue;
        let cells = this.#discovered.get(slot);
        if (!cells) this.#discovered.set(slot, cells = []);
        for (const cell of admission.discovered) cells.push(cell);
        if (cells.length !== admission.total) throw new RangeError(`tick-projection: slot ${slot} holds ${cells.length} cells, the core ${admission.total}`);
      }
    } finally { stop('sim.admit'); }
  }

  /**
   * A player's view of the last completed tick's frame, from the core's decision. Undefined for a viewer without a seat, a
   * frame of another tick, or a disposed match; the caller then projects by the rules.
   */
  project(frame: Snapshot, id: PlayerId | null | undefined, wire: WireIds = wireIds()) {
    if (id == null || frame.tick !== this.#frames.tick) return undefined;
    const slot = this.#slotOf(id);
    if (slot === undefined) return undefined;
    if (!this.#current() || !this.#decided.has(slot)) this.decide([id]);
    const admission = this.#current() ? this.#decided.get(slot) : undefined;
    if (!admission) return undefined;
    start('sim.playerView');
    try {
      const read = readFrame(frame);
      return assembleView(read, viewerOf(read, id, slot), this.decision(read, slot, admission), wire);
    } finally { stop('sim.playerView'); }
  }

  /** The core's admission as a decision over the frame's own records, in the frame's order. */
  decision(read: ReadFrame, slot: PlayerIdx, a: Admission): ViewDecision {
    const { frame, players, ground } = read, ids = this.#match.ids, lives = this.#frames.lives;
    const admitted = new Set(a.players.map(word => ids.slotOfActor.get(word)));
    const bodyIds = a.bodies.map(body => {
      const life = lives.get(bodyKey(body));
      if (!life) throw new RangeError(`tick-projection: the core admitted ${bodyKey(body)}, which has no lifetime`);
      return life.id as number;
    });
    const tethers = new Set(a.tethers), flights = new Set(a.flights), shots = new Set(a.projectiles), effects = new Set(a.effects);
    const traps = frame.traps ?? [];
    return {
      players: players.filter(p => admitted.has(p.playerIdx)),
      items: picked(ground, a.items, 'item'),
      bodies: frame.bodies ? picked(frame.bodies, bodyIds, 'body') : [],
      tethers: (frame.tethers ?? []).filter(t => tethers.has(t.id)),
      hookFlights: frame.hookFlights?.filter(h => flights.has(h.id)),
      traps: [...a.traps].sort((x, y) => x - y).map(i => {
        const trap = traps[i];
        if (!trap) throw new RangeError(`tick-projection: the core admitted trap ${i}, which the frame does not hold`);
        return trap;
      }),
      projectiles: frame.projectiles.filter(p => shots.has(p.id)),
      effects: frame.effects.filter((_, i) => effects.has(i)),
      discovered: a.total < 0 ? null : this.#discovered.get(slot)!,
      heard: this.#heard.get(slot)!,
    };
  }

  /** The player holding a roster place now. */
  #idAt(slot: PlayerIdx): PlayerId | undefined {
    return this.#match.ids.playerOfActor.get(this.#match.ids.actorAtSlot[slot]!);
  }

  /** Ask the core for a viewer's decision at the last completed tick unless one is held; nothing once disposed. */
  #ensure(slot: PlayerIdx): void {
    if (this.#current() && this.#decided.has(slot)) return;
    const id = this.#idAt(slot);
    if (id !== undefined) this.decide([id]);
  }

  /**
   * A viewer's discovered cells in the order learned, as the core sent them, or null when it keeps none. While the match is
   * live this asks the core first; after it is disposed, it answers what was last sent (the room decides every seat once
   * before disposing).
   */
  discovered(slot: PlayerIdx): readonly number[] | null {
    this.#ensure(slot);
    const decided = this.#decided.get(slot);
    return decided && decided.total < 0 ? null : this.#discovered.get(slot) ?? null;
  }

  /** The cues a viewer hears that last past `tick`, as `discovered` reads them. */
  heard(slot: PlayerIdx, tick: Tick): readonly HeardCue[] {
    this.#ensure(slot);
    return this.#heard.get(slot)?.filter(cue => cue.until > tick) ?? [];
  }

  /** The core's decision for a viewer at the last decided tick, for checks. */
  admission(id: PlayerId): Admission | undefined {
    const slot = this.#slotOf(id);
    return slot === undefined || !this.#current() ? undefined : this.#decided.get(slot);
  }
}
