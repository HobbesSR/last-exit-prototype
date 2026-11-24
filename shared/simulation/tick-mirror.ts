import { attachDiscovery, discoveryGrid } from '../discovery.ts';
import { ItemMemory, SeenCells } from './bot-memory.ts';
import { WEAPONS as WEAPON_ORDER } from '../enum-tables.ts';
import { cos, sin } from '../math.ts';
import { beginDynamicNavigationCollection, endDynamicNavigationCollection } from './dynamic-navigation.ts';
import { collectBotIntent } from './bots.ts';
import { writeDoor } from './doors.ts';
import { effect, event, participant } from './event-records.ts';
import { addItemsFromCore, groundItem, removeItem, replaceItem } from './ground-items.ts';
import { sightOf } from './sight-runtime.ts';
import { botCommand, rollMargin } from './tick-boundary.ts';
import { bodyKey, bodyOrder } from './tick-codec.ts';
import type { TickBoundary } from './tick-boundary.ts';
import type { Actor, ActorEntry, CarriedItem, Cue, DecodedTick, Discontinuity, Equipment, Fact, GroundItem as CoreGround, Hook, Inbound, Loot,
  Memory, Point, PoseEntry, Projectile as CoreProjectile, Snapshot, Tick, Trap as CoreTrap, Window } from './tick-codec.ts';
import type { MatchIds, TickMatch } from './tick-match.ts';
import type { BodyId, DiscoveryMemory, Game, HeardCue, GroundItem, InventoryItem, Player, PlayerId, PlayerStatus, Projectile, Trap } from '../types.ts';

// The mirror applier of the new tick (docs/27.2 "Node adapter (3d.2)"): one function writes a completed tick's change list
// onto `Game`, the mirror Node's bots, projection and tools read until #1284 removes it. It replaces the old tick's
// per-phase appliers on this path; nothing here runs on the old one. `mirrorOf` maps a whole snapshot the same way, which
// is what a test holds the incrementally applied mirror equal to on every tick.
//
// Decisions (27.2 records them):
// - **Countdowns.** The core keeps deadlines; the mirror keeps the countdown fields its readers know, each the deadline
//   less the mirror's tick, never below zero (the loader's inverse). Unchanged records are not resent, so the mirror
//   recomputes them every tick from the deadlines it last received, for actors (the roster) and for the traps and
//   projectiles still counting (the active set). A passed deadline reads as zero, so the mirror holds no past.
// - **Facts make presentation.** Effects and `GameEvent` payloads are built from T's facts after the records apply, with
//   the old effect kinds and radii, at the committed poses.
// - **Identity.** A core item ID is the mirror's `ItemId` (the loader keeps them), so the ID maps need no item table;
//   `itemSerial` follows the largest seen. Actors, gates, traps and stations go through `MatchIds`.
// - **Records the mirror has no field for** (hooks, and every dynamic body's whole pose and lifetime) are kept beside it,
//   for the frame (`tick-frame.ts`). `apply` is the one reader of a tick's discontinuities, so a frame built after it is
//   never a lifetime behind.

/** The old effect kinds and radii (`rust/core/src/action_combat.rs`, `combat.rs`, `hazards.rs`, `phase_six.rs`). */
const EFFECT = Object.freeze({ slash: 55, slashReach: 30, shock: 130, scan: 450, upgrade: 75, loot: 30, rail: 60, charge: 70, grapple: 35 });
const STATUS: Record<Actor['presence'], PlayerStatus> = {
  pending: 'respawning', active: 'active', eliminated: 'eliminated', escaped: 'escaped', transit: 'transit', stranded: 'stranded',
};

/** What a ground record carries that the core does not: generation metadata, kept by ID. */
type Metadata = Pick<GroundItem, 'buildingId' | 'nodeId' | 'tier'>;
/** Per player, whether it started with the optional records the core always has. */
interface Shape { inventory: boolean; reserves: boolean }

/** One lifetime of a body in the world: its presentation ID and its generation within that lifetime. */
export interface BodyLife { readonly id: BodyId; readonly generation: number }

/**
 * The bodies' lifetimes, from the core's discontinuity markers (27.2 "Frames (3d.3)"). A body gets a new presentation ID
 * when it enters the world and keeps it until it leaves; IDs count across the match, and the wire key maps them outward
 * (#1164). A generation counts within one lifetime: 1 on entry, renewed by a warp, so `(id, generation)` changes whenever a
 * viewer must not interpolate (24.4), and no count of the match's placements or warps reaches a client.
 */
export class BodyLives {
  #serial = 0;
  readonly #lives = new Map<string, BodyLife>();
  #placed: ReadonlySet<string> = new Set();
  /** Bodies already in the world at the start, keyed `kind:id`, in body order. */
  start(keys: Iterable<string>): void { for (const key of keys) this.#begin(key); }
  #begin(key: string): void { this.#lives.set(key, Object.freeze({ id: ++this.#serial as BodyId, generation: 1 })); }
  /**
   * A completed tick's markers. Removals end lifetimes first, so a body that left and entered again in one tick starts a
   * new one. A warp of a body with no lifetime starts one.
   */
  take(markers: readonly Discontinuity[]): void {
    const placed = new Set<string>();
    for (const marker of markers) if (marker.kind === 'removed') this.#lives.delete(bodyKey(marker.body));
    for (const marker of markers) {
      const key = bodyKey(marker.body), life = this.#lives.get(key);
      if (marker.kind === 'placed') { this.#begin(key); placed.add(key); }
      else if (marker.kind === 'warped') {
        if (life) this.#lives.set(key, Object.freeze({ id: life.id, generation: life.generation + 1 })); else this.#begin(key);
      }
    }
    this.#placed = placed;
  }
  get(key: string): BodyLife | undefined { return this.#lives.get(key); }
  /** Whether the body entered the world in the last tick taken. */
  placed(key: string): boolean { return this.#placed.has(key); }
}

/** What the applier needs besides the game: the IDs and what the start fixed. */
interface Context {
  ids: MatchIds; metadata: ReadonlyMap<number, Metadata>; shapes: ReadonlyMap<number, Shape>; blast: number;
  grid: { cols: number; rows: number };
  /** Whether the content keeps discovery. Off, the mirror keeps no memory, as the old game attaches none. */
  discovery: boolean;
}

const remaining = (deadline: Tick, tick: Tick): Tick => Math.max(0, deadline - tick);
/** A status window as a countdown at `tick`: the old field is in effect at T while `T < tick + v`. */
function windowLeft(window: Window | undefined, tick: Tick): Tick {
  if (!window) return 0;
  if (window.activeFrom > tick + 1) throw new RangeError(`tick-mirror: a window from ${window.activeFrom} is not yet in effect at ${tick + 1}`);
  return remaining(window.expiresAt, tick);
}

/** Write `value`, or drop the key for undefined, so an absent field stays absent as the old rules leave it. */
function set<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key]; else target[key] = value;
}

function equipmentFields(e: Equipment): Pick<InventoryItem, 'kind'> & Record<string, unknown> {
  const quality = e.quality === 1 ? {} : { quality: e.quality };
  switch (e.kind.kind) {
    case 'firearm': return { kind: 'weapon', weaponType: e.kind.weapon, ammo: e.kind.rounds, ...quality };
    case 'cell': return { kind: 'cell', charge: e.kind.charge, ...quality };
    case 'stack': return { kind: e.kind.utility === 'medkit' ? 'med' : 'shield', count: e.kind.count, ...quality };
  }
}
function lootFields(loot: Loot): Record<string, unknown> {
  switch (loot.kind) {
    case 'accessKey': return { kind: 'access' };
    case 'ammo': return { kind: 'ammo', family: loot.family, count: loot.count };
    case 'equipment': return equipmentFields(loot.equipment);
  }
}
const carriedOf = (c: CarriedItem): InventoryItem => ({ ...equipmentFields(c.equipment), instanceId: c.id, lineageId: c.lineage }) as InventoryItem;

/** A ground record as the mirror holds it, at `at`: its body's pose when placed, else where it waits. */
export function groundOf(ctx: Context, id: number, item: CoreGround, at: Point): GroundItem {
  const record = { id, x: at[0], y: at[1], ...lootFields(item.loot) } as GroundItem & Record<string, unknown>;
  if (item.lineage !== null) record.lineageId = item.lineage as never;
  if (item.droppedBy !== null) record.droppedBy = ctx.ids.playerOfActor.get(item.droppedBy);
  if (item.pickupReadyAt > 0) record.pickupAfter = item.pickupReadyAt;
  const meta = ctx.metadata.get(id);
  if (meta) for (const key of ['buildingId', 'nodeId', 'tier'] as const) if (meta[key] !== undefined) (record as Record<string, unknown>)[key] = meta[key];
  return record;
}

/** The player fields an actor record stands for, at tick `tick`, written onto `p` (a player, or a blank for the oracle). */
function writeActor(ctx: Context, p: Partial<Player>, word: number, a: Actor, tick: Tick): void {
  const ids = ctx.ids, shape = ctx.shapes.get(word)!;
  p.status = STATUS[a.presence];
  p.level = a.level; p.kills = a.kills; p.hp = a.hp; p.maxHp = a.maxHp; p.shield = a.shield; p.heading = a.aim; p.bot = a.bot;
  set(p, 'viewLagTicks', a.viewLag > 0 ? a.viewLag : undefined);
  const inv = a.inventory;
  if (shape.inventory) {
    p.inventory = inv.slots.map(slot => slot ? carriedOf(slot) : null);
    p.selectedSlot = inv.selected;
    const item = p.inventory[inv.selected];
    p.weapon = item?.kind === 'weapon' ? WEAPON_ORDER.indexOf(item.weaponType) + 1 : 0;
  }
  if (shape.reserves) p.reserves = { pistol: inv.reserves[0], rifle: inv.reserves[1], shell: inv.reserves[2] };
  p.keys = inv.keys;
  p.reload = inv.reload ? { slot: inv.reload.slot, instanceId: inv.reload.item as never, until: inv.reload.readyAt } : null;
  const station = a.charging ? ids.stations[a.charging.station] : undefined;
  p.charging = station?.kind === 'charging' ? station.id : null;
  p.respawnAt = a.respawnAt;
  const to = a.transit ? ids.stations[a.transit.destination] : undefined;
  set(p, 'transit', to?.kind === 'transit' ? { to: to.id, arriveAt: a.transit!.arriveAt } : undefined);
  set(p, 'aggressor', a.aggression ? ids.playerOfActor.get(a.aggression.source) : undefined);
  set(p, 'aggressionUntil', a.aggression?.expiresAt);
  countdowns(p, a, tick);
}
function countdowns(p: Partial<Player>, a: Actor, tick: Tick): void {
  p.cooldown = remaining(a.deadlines.skillReadyAt, tick);
  p.attackCd = remaining(a.deadlines.weaponReadyAt, tick);
  p.railCd = remaining(a.deadlines.transitReadyAt, tick);
  p.boost = windowLeft(a.statuses.boost, tick);
  p.cloak = windowLeft(a.statuses.cloak, tick);
  p.revealed = windowLeft(a.statuses.reveal, tick);
  p.stun = windowLeft(a.statuses.stun, tick);
}

function writeTrap(ctx: Context, trap: Trap, t: CoreTrap, tick: Tick): void {
  trap.x = t.position[0]; trap.y = t.position[1]; trap.heading = t.heading; trap.cooldown = remaining(t.readyAt, tick);
  const k = t.kind;
  if (k.kind === 'mine') trap.spent = k.spent;
  else if (k.kind === 'turret') trap.aiming = k.aiming;
  else if (k.kind === 'flame') { trap.warning = k.warning; trap.firing = k.firing; }
  else { trap.homeX = k.home[0]; trap.homeY = k.home[1]; trap.targetId = k.target === null ? null : ctx.ids.playerOfActor.get(k.target)!; }
}

function projectileOf(ctx: Context, id: number, p: CoreProjectile, tick: Tick): Projectile {
  const source = p.source, trap = source.kind === 'trap';
  const owner = trap ? ctx.ids.trapIds[source.id]! : ctx.ids.playerOfActor.get(source.id)!;
  return { id, owner, ...(trap ? { trap: true } : {}), x: p.position[0], y: p.position[1], dx: p.velocity[0], dy: p.velocity[1],
    life: remaining(p.expiresAt, tick), damage: p.damage };
}

const heardOf = (cue: Cue): HeardCue => ({ x: cue.at[0], y: cue.at[1], tick: cue.tick, until: cue.until });

/** An empty memory in the bots' own structures (`bot-memory.ts`), which keep the frontier and the loot grid. */
function emptyMemory(ctx: Context): DiscoveryMemory {
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
function writeMemory(ctx: Context, d: DiscoveryMemory, m: Memory): DiscoveryMemory {
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
  hooks: [number, Hook][];
  /** Every dynamic body's pose, in body order. */
  poses: PoseEntry[];
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
  /** Hooks and every dynamic body's whole pose (keyed `kind:id`), which the game has no field for. */
  readonly hooks = new Map<number, Hook>();
  readonly poses = new Map<string, PoseEntry>();
  readonly lives = new BodyLives();
  /** Each projectile's deadline, for its countdown. */
  readonly #expires = new Map<number, Tick>();

  readonly s: Game;
  readonly match: TickMatch;

  constructor(s: Game, match: TickMatch) {
    this.s = s; this.match = match;
    const metadata = new Map<number, Metadata>();
    for (const item of s.items) metadata.set(item.id, { buildingId: item.buildingId, nodeId: item.nodeId, tier: item.tier });
    const shapes = new Map(s.players.map((p, slot) => [match.ids.actorAtSlot[slot]!, { inventory: p.inventory !== undefined, reserves: p.reserves !== undefined }] as const));
    this.ctx = { ids: match.ids, metadata, shapes, blast: s.content.traps.mine.blast, grid: discoveryGrid(s.map),
      discovery: s.content.discovery === true };
    this.#load(match.snapshot());
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
    for (const pose of snap.poses) this.poses.set(bodyKey(pose.body), pose);
    this.lives.start(snap.poses.map(p => bodyKey(p.body)));
    for (const p of s.players) this.#memory(p, true);
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
  /** Refresh a contestant's memory from the match; `fresh` starts it over, as at the start, where the core's holds nothing yet. */
  #memory(p: Player, fresh = false): void {
    if (p.role !== 'contestant' || !this.ctx.discovery) return;
    const memory = this.match.memory(p.id);
    if (!memory) return;
    if (fresh || !p.discovery) attachDiscovery(p, emptyMemory(this.ctx));
    writeMemory(this.ctx, p.discovery!, memory);
  }

  /** Write one completed tick onto the mirror. */
  apply(t: DecodedTick): void {
    const s = this.s, ctx = this.ctx, ids = ctx.ids, c = t.changes, tick = t.tick, at = poseMap(c.poses);
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
      else if (gone.kind === 'hook') this.hooks.delete(gone.id);
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
    for (const e of c.hooks) this.hooks.set(e.id, e.hook);
    for (const marker of t.discontinuities) if (marker.kind === 'removed') this.poses.delete(bodyKey(marker.body));
    this.lives.take(t.discontinuities);
    for (const pose of c.poses) {
      this.poses.set(bodyKey(pose.body), pose);
      if (pose.body.kind === 'actor') { const p = this.#player(pose.body.id); p.x = pose.at[0]; p.y = pose.at[1]; }
    }
    // Countdowns from the kept deadlines: every actor, the counting traps, every projectile.
    for (const [word, actor] of this.#actors) countdowns(this.#player(word), actor, tick);
    for (const [index, readyAt] of this.#counting) {
      s.traps[index]!.cooldown = remaining(readyAt, tick);
      if (readyAt <= tick) this.#counting.delete(index);
    }
    for (const p of s.projectiles) p.life = remaining(this.#expires.get(p.id)!, tick);
    // Presentation, from the facts.
    for (const e of s.effects) e.life--;
    s.effects = s.effects.filter(e => e.life > 0);
    this.#facts(c.events.map(e => e.fact));
    // What each player knows and hears, and what each connection has had spent.
    const learned = new Set([...t.discovery.gates.map(g => g.actor), ...t.discovery.samples.map(x => x.actor)]);
    for (const p of s.players) {
      const word = ids.actorOfPlayer.get(p.id)!;
      if (learned.has(word)) this.#memory(p);
      const cues = this.match.heard(p.id);
      if (cues.length || p.heard?.length) {
        if (!p.heard) Object.defineProperty(p, 'heard', { value: [], writable: true, configurable: true, enumerable: false });
        p.heard = cues.map(heardOf);
      }
      if (!p.bot) { p.lastSeq = this.match.acknowledged(p.id) ?? -1; rollMargin(p); }
    }
  }

  #facts(facts: readonly Fact[]): void {
    const s = this.s;
    const player = (word: number): Player => this.#player(word);
    const credited = new Map<number, number>();
    for (const f of facts) if (f.kind === 'killCredited') credited.set(f.target, f.actor);
    for (const f of facts) {
      switch (f.kind) {
        case 'escaped': event(s, { kind: 'pod_powered', actor: participant(s, player(f.actor)), slotsRemaining: f.slots }); break;
        case 'cellCharged': { const p = player(f.actor); event(s, { kind: 'cell_charged', actor: participant(s, p) }); effect(s, p, 'charge', EFFECT.charge); break; }
        case 'eliminated': {
          const source = credited.get(f.actor);
          event(s, { kind: 'eliminated', target: participant(s, player(f.actor)), ...(source !== undefined ? { source: participant(s, player(source)) } : {}) });
          break;
        }
        case 'respawned': event(s, { kind: 'respawned', actor: participant(s, player(f.actor)) }); break;
        case 'finished': event(s, { kind: 'match_finished' }); s.phase = 'finished'; break;
        case 'meleeSwung': {
          const p = player(f.actor);
          effect(s, { x: p.x + cos(p.heading) * EFFECT.slashReach, y: p.y + sin(p.heading) * EFFECT.slashReach }, 'slash', EFFECT.slash);
          break;
        }
        case 'wardenPulsed': effect(s, player(f.actor), 'shock', EFFECT.shock); break;
        case 'specterScanned': effect(s, player(f.actor), 'scan', EFFECT.scan); break;
        case 'boosted': effect(s, player(f.actor), 'upgrade', EFFECT.upgrade); break;
        case 'utilityUsed': case 'pickup': effect(s, player(f.actor), 'loot', EFFECT.loot); break;
        case 'transitDeparted': case 'transitLanded': effect(s, player(f.actor), 'rail', EFFECT.rail); break;
        case 'mineExploded': effect(s, s.traps[f.trap]!, 'shock', this.ctx.blast); break;
        case 'spiderGrappled': effect(s, { x: f.at[0], y: f.at[1] }, 'grapple', EFFECT.grapple); break;
        default: break;
      }
    }
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
      hooks: [...this.hooks].sort((a, b) => a[0] - b[0]),
      poses: [...this.poses.values()].sort((a, b) => bodyOrder(a.body, b.body)),
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
      hooks: snap.state.hooks.map(e => [e.id, e.hook] as [number, Hook]),
      poses: snap.poses,
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
 * Run one tick of `s` on the new path (27.2 "Node adapter (3d.2)"). Each active bot's intent is
 * read from the mirror as T−1 left it (R11), in roster order as today until #1215, and submitted for T; the match steps;
 * the mirror applies the result. Player input waits in `boundary`'s buffers between calls, and each player's input for T
 * is submitted with the bots'. Returns the
 * completed tick, or null once the match is over.
 */
export function stepMirror(mirror: TickMirror, boundary?: TickBoundary): DecodedTick | null {
  const { s, match } = mirror;
  if (s.phase !== 'live') return null;
  const tick = s.tick + 1, rows: Inbound[] = boundary?.due(tick) ?? [];
  beginDynamicNavigationCollection(s);
  try {
    for (const p of s.players) if (p.bot && p.status === 'active')
      rows.push({ type: 'command', command: botCommand(s, match, p, collectBotIntent(s, p), tick) });
  } finally { endDynamicNavigationCollection(s); }
  if (rows.length && !match.submit(tick, rows).every(Boolean)) throw new Error(`tick-mirror: the match refused a command for ${tick}`);
  const completed = match.step();
  if (completed) mirror.apply(completed);
  return completed;
}
