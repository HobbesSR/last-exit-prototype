import { writeDoor } from './doors.ts';
import { addItemsFromCore, groundItem, removeItem, replaceItem } from './ground-items.ts';
import { sightOf } from './sight-runtime.ts';
import { acknowledge } from './tick-boundary.ts';
import { TickKnowledge, emptyMemory, heardOf, writeMemory } from './tick-knowledge.ts';
import { contextOf, countdowns, groundOf, participantOf, present, projectileOf, remaining, writeActor, writeTrap } from './tick-records.ts';
import type { Cast, Context } from './tick-records.ts';
import { bodyKey } from './tick-codec.ts';
import type { TickBoundary } from './tick-boundary.ts';
import type { Actor, ActorEntry, DecodedTick, Inbound, Point, PoseEntry, Snapshot, Tick, Trap as CoreTrap } from './tick-codec.ts';
import type { TickMatch } from './tick-match.ts';
import type { DiscoveryMemory, Game, HeardCue, Player, PlayerId, Projectile, Trap, GroundItem } from '../types.ts';

// The mirror applier of the new tick (docs/27.2 "Node adapter (3d.2)"): one function writes a completed tick's change list
// onto `Game`, the mirror that the room's roster reads until #1284 removes it. Frames no longer read it: they are built
// from the core's output (`tick-frame.ts`), and in-process games, tests and tools do not run it (#1345): they read the
// frame store's records (`stateOf`). What each player knows and hears is `tick-knowledge.ts`, which the mirror runs too. `mirrorOf` maps a whole snapshot the same way, which
// is what a test holds the incrementally applied mirror equal to on every tick. The mapping itself is `tick-records.ts`.
//
// - **Countdowns.** Unchanged records are not resent, so the mirror recomputes them every tick from the deadlines it last
//   received, for actors (the roster) and for the traps and projectiles still counting (the active set). A passed
//   deadline reads as zero, so the mirror holds no past.
// - **Identity.** `itemSerial` follows the largest item ID seen.

/** What the mirror holds, in one comparable shape: from the game (`viewOf`) or from a snapshot (`mirrorOf`). */
export interface MirrorView {
  tick: Tick;
  players: Record<string, unknown>[];
  items: GroundItem[];
  projectiles: Projectile[];
  gates: { open: boolean; locked: boolean }[];
  traps: Trap[];
  slots: number;
  hazardX: number;
  /** Each player's discovery memory and the cues it hears, in roster order. */
  knowledge: { memory: DiscoveryMemory | null; heard: HeardCue[] }[];
}

/**
 * The live mirror of one match: the game it writes and the records it keeps beside it. Construct it on the game the match
 * was set up from, before the first step.
 */
export class TickMirror {
  readonly ctx: Context;
  /** The last actor record received per actor word: the deadlines countdowns are recomputed from. */
  readonly #actors = new Map<number, Actor>();
  /** Traps whose deadline has not passed, by index. */
  readonly #counting = new Map<number, Tick>();
  /** Each projectile's deadline, for its countdown. */
  readonly #expires = new Map<number, Tick>();

  readonly s: Game;
  readonly match: TickMatch;
  readonly knowledge: TickKnowledge;
  readonly #cast: Cast;

  constructor(s: Game, match: TickMatch) {
    this.s = s; this.match = match;
    this.ctx = contextOf(s, match);
    // The facts' actors and traps, as the mirror holds them after T's records apply.
    this.#cast = {
      actor: word => this.#player(word),
      participant: word => { const slot = this.ctx.ids.slotOfActor.get(word)!; return participantOf(slot, s.players[slot]!); },
      trap: index => s.traps[index]!,
      blast: this.ctx.blast,
    };
    this.#load(match.snapshot());
    this.knowledge = new TickKnowledge(s, match, this.ctx);
  }

  /** Make the game the snapshot's, whole: once, at the start. */
  #load(snap: Snapshot): void {
    const s = this.s, ctx = this.ctx, at = poseMap(snap.poses);
    for (const e of snap.state.actors) this.#actor(e, snap.tick, at.get(`actor:${e.word}`));
    for (const e of snap.state.items) {
      const old = groundItem(s, e.id as never);
      const next = groundOf(ctx, e.id, e.item, at.get(`item:${e.id}`) ?? e.item.unplacedAt ?? [old!.x, old!.y]);
      if (old) replaceItem(s, old, next, true); else addItemsFromCore(s, [next]);
    }
    snap.state.traps.forEach(e => this.#trap(e.id, e.trap, snap.tick));
  }

  #player(word: number): Player { return this.s.players[this.ctx.ids.slotOfActor.get(word)!]!; }
  /** Keep live references to a roster place when its outward label changes. */
  relabel(previous: PlayerId, next: PlayerId): void {
    for (const p of this.s.players) if (p.aggressor === previous) p.aggressor = next;
    for (const shot of this.s.projectiles) if (!shot.trap && shot.owner === previous) shot.owner = next;
    for (const trap of this.s.traps) if (trap.kind === 'spider' && trap.targetId === previous) trap.targetId = next;
    for (const item of this.s.items) if (item.droppedBy === previous) replaceItem(this.s, item, { ...item, droppedBy: next }, true);
  }
  /** An actor's record, and its pose when given (at the start; a tick's poses are written apart, moved or not). */
  #actor(e: ActorEntry, tick: Tick, at?: Point): void {
    const p = this.#player(e.word);
    this.#actors.set(e.word, e.actor);
    writeActor(this.ctx, p, e.word, e.actor, tick);
    p.input = { ...p.input, sneak: e.actor.sneak };
    if (at) { p.x = at[0]; p.y = at[1]; }
    for (const slot of e.actor.inventory.slots) if (slot) this.#serial(slot.id);
  }
  #trap(index: number, t: CoreTrap, tick: Tick): void {
    writeTrap(this.ctx, this.s.traps[index]!, t, tick);
    if (t.readyAt > tick) this.#counting.set(index, t.readyAt); else this.#counting.delete(index);
  }
  #serial(id: number): void { if (this.s.itemSerial === undefined || this.s.itemSerial <= id) this.s.itemSerial = id + 1; }
  /** Write one completed tick onto the mirror. */
  apply(t: DecodedTick): void {
    const s = this.s, ctx = this.ctx, c = t.changes, tick = t.tick, at = poseMap(c.poses);
    s.tick = tick;
    // Records, whole.
    for (const e of c.actors) this.#actor(e, tick);
    for (const e of c.gates) {
      const gate = s.gates[e.id]!;
      if (gate.open === e.gate.open && gate.locked === e.gate.locked) continue;
      sightOf(s).writeGate(s.map, e.id, e.gate.open, e.gate.locked ? 1 : 2);
      if (gate.open !== e.gate.open) writeDoor(gate, 'open', e.gate.open);
      if (gate.locked !== e.gate.locked) writeDoor(gate, 'locked', e.gate.locked);
    }
    for (const e of c.traps) this.#trap(e.id, e.trap, tick);
    if (c.extraction) s.slots = c.extraction.slots;
    if (c.hazardX !== null) s.hazardX = c.hazardX;
    // The ground: removals, then changed records and moved bodies, each replaced once.
    let projectiles: Map<number, Projectile> | undefined;
    for (const gone of c.removed) {
      if (gone.kind === 'item') { const item = groundItem(s, gone.id as never); if (item) removeItem(s, item, true); }
      else if (gone.kind === 'projectile') { (projectiles ??= byId(s.projectiles)).delete(gone.id); this.#expires.delete(gone.id); }
    }
    const changed = new Map(c.items.map(e => [e.id, e.item] as const));
    // A body that moved with its record unchanged keeps the record and takes the pose. A pose that changed only its
    // rotation, motion or sleep leaves the published record alone.
    for (const pose of c.poses) if (pose.body.kind === 'item' && !changed.has(pose.body.id)) {
      const old = groundItem(s, pose.body.id as never);
      if (old && (old.x !== pose.at[0] || old.y !== pose.at[1])) replaceItem(s, old, { ...old, x: pose.at[0], y: pose.at[1] }, true);
    }
    for (const [id, record] of changed) {
      const old = groundItem(s, id as never), pose = at.get(`item:${id}`);
      const position = record.unplacedAt ?? pose ?? (old ? [old.x, old.y] as Point : undefined);
      if (!position) throw new RangeError(`tick-mirror: ground item ${id} is placed with no pose`);
      const next = groundOf(ctx, id, record, position);
      if (old) replaceItem(s, old, next, true); else addItemsFromCore(s, [next]);
      this.#serial(id);
    }
    if (c.projectiles.length) projectiles ??= byId(s.projectiles);
    for (const e of c.projectiles) { projectiles!.set(e.id, projectileOf(ctx, e.id, e.projectile, tick)); this.#expires.set(e.id, e.projectile.expiresAt); }
    if (projectiles) s.projectiles = [...projectiles.values()].sort((a, b) => a.id - b.id);
    for (const pose of c.poses) if (pose.body.kind === 'actor') { const p = this.#player(pose.body.id); p.x = pose.at[0]; p.y = pose.at[1]; }
    // Countdowns from the kept deadlines: every actor, the counting traps, every projectile.
    for (const [word, actor] of this.#actors) countdowns(this.#player(word), actor, tick);
    for (const [index, readyAt] of this.#counting) {
      s.traps[index]!.cooldown = remaining(readyAt, tick);
      if (readyAt <= tick) this.#counting.delete(index);
    }
    for (const p of s.projectiles) p.life = remaining(this.#expires.get(p.id)!, tick);
    // Presentation, from the facts.
    if (present(s, c.events.map(e => e.fact), this.#cast)) s.phase = 'finished';
  }


  /** The mirror as it stands, in the comparable shape. Fields are those `mirrorOf` writes for the same snapshot. */
  view(expected: MirrorView): MirrorView {
    const s = this.s;
    return {
      tick: s.tick,
      players: s.players.map((p, i) => Object.fromEntries(Object.keys(expected.players[i]!).map(key => [key, (p as never)[key]]))),
      items: [...s.items].sort((a, b) => a.id - b.id),
      projectiles: [...s.projectiles],
      gates: s.gates.map(g => ({ open: g.open, locked: g.locked })),
      traps: s.traps.map(t => ({ ...t })),
      slots: s.slots, hazardX: s.hazardX,
      knowledge: s.players.map(p => ({ memory: p.discovery ?? null, heard: p.heard ?? [] })),
    };
  }

  /**
   * A whole snapshot mapped as the applier maps changes: the oracle a test holds `view` equal to. An actor with no body
   * has no position here; the mirror keeps its last one. A trap's static fields come from the mirror's own record.
   * `remembers` limits which contestants' memory is decoded from the match; the others keep the mirror's own. Decoding
   * every memory every tick dominates a whole match's check once bots remember the map's loot.
   */
  mirrorOf(snap: Snapshot, remembers: (p: Player) => boolean = () => true): MirrorView {
    const ctx = this.ctx, at = poseMap(snap.poses), tick = snap.tick;
    const players = this.s.players.map((p, slot) => {
      const e = snap.state.actors.find(x => x.word === ctx.ids.actorAtSlot[slot])!, out: Partial<Player> = {};
      writeActor(ctx, out, e.word, e.actor, tick);
      const pose = at.get(`actor:${e.word}`);
      if (pose) { out.x = pose[0]; out.y = pose[1]; }
      out.input = { ...p.input, sneak: e.actor.sneak };
      // Every key, so a field the mirror should have dropped is compared too.
      for (const key of ['viewLagTicks', 'transit', 'aggressor', 'aggressionUntil'] as const) if (!(key in out)) out[key] = undefined;
      return out as Record<string, unknown>;
    });
    const items = snap.state.items.map(e => groundOf(ctx, e.id, e.item, e.item.unplacedAt ?? at.get(`item:${e.id}`)!));
    const traps = snap.state.traps.map(e => { const trap = { ...this.s.traps[e.id]! }; writeTrap(ctx, trap, e.trap, tick); return trap; });
    return {
      tick, players, items,
      projectiles: snap.state.projectiles.map(e => projectileOf(ctx, e.id, e.projectile, tick)),
      gates: snap.state.gates.map(e => ({ open: e.gate.open, locked: e.gate.locked })),
      traps, slots: snap.state.extraction?.slots ?? this.s.slots, hazardX: snap.state.hazardX ?? this.s.hazardX,
      // The match's own, as of its last completed tick: the snapshot's.
      knowledge: this.s.players.map(p => {
        const heard = this.match.heard(p.id).map(heardOf);
        if (!remembers(p)) return { memory: p.discovery ?? null, heard };
        const memory = p.role === 'contestant' && ctx.discovery ? this.match.memory(p.id) : null;
        return { memory: memory ? writeMemory(ctx, emptyMemory(ctx), memory) : null, heard };
      }),
    };
  }
}

function poseMap(poses: readonly PoseEntry[]): Map<string, Point> {
  return new Map(poses.map(p => [bodyKey(p.body), p.at] as const));
}
function byId(list: readonly Projectile[]): Map<number, Projectile> { return new Map(list.map(p => [p.id, p] as const)); }

/**
 * Submit the player input due for T, then step the core and apply its completed tick to the mirror and the players'
 * knowledge. The core derives bot intent from the committed T−1 state. Returns null once the match is over.
 */
export function stepMirror(mirror: TickMirror, boundary?: TickBoundary): DecodedTick | null {
  const { s, match } = mirror;
  if (s.phase !== 'live') return null;
  const completed = submitAndStep(s, match, boundary);
  if (completed) {
    mirror.apply(completed); mirror.knowledge.apply(completed);
    if (boundary) boundary.acknowledge(); else acknowledge(s, match);
  }
  return completed;
}

/** Submit the player input due for the game's next tick, then step the core. */
export function submitAndStep(s: Game, match: TickMatch, boundary?: TickBoundary): DecodedTick | null {
  const tick = s.tick + 1, rows: Inbound[] = boundary?.due(tick) ?? [];
  if (rows.length && !match.submit(tick, rows).every(Boolean)) throw new Error(`tick-mirror: the match refused a command for ${tick}`);
  return match.step();
}
