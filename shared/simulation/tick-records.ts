import { discoveryGrid } from '../discovery.ts';
import { WEAPONS as WEAPON_ORDER } from '../enum-tables.ts';
import { cos, sin } from '../math.ts';
import { effect, event } from './event-records.ts';
import { bodyKey } from './tick-codec.ts';
import type { Actor, CarriedItem, Discontinuity, Equipment, Fact, GroundItem as CoreGround, Loot, Point, Projectile as CoreProjectile, Tick,
  Trap as CoreTrap, Window } from './tick-codec.ts';
import type { MatchIds, TickMatch } from './tick-match.ts';
import type { BodyId, EventParticipant, Game, GroundItem, InventoryItem, Player, PlayerStatus, Projectile, Trap, Vec2 } from '../types.ts';

// The one mapping from the core's records to the records Node's frames and mirror hold (docs/27.2 "Frames"): actors to
// player fields, ground and carried items, traps and projectiles, T's facts to effects and events, and bodies' lifetimes.
// Pure functions over a match's `Context`, so the frame store (`tick-frame.ts`) and the mirror (`tick-mirror.ts`) read the
// same output the same way.
//
// - **Countdowns.** The core keeps deadlines; a record keeps the countdown fields its readers know, each the deadline less
//   the record's tick, never below zero (the loader's inverse).
// - **Facts make presentation.** Effects and `GameEvent` payloads are built from T's facts after the records apply, with
//   the old effect kinds and radii, at the committed poses.
// - **Identity.** A core item ID is the outward `ItemId` (the loader keeps them). Actors, gates, traps and stations go
//   through `MatchIds`.

/** The old effect kinds and radii (`rust/core/src/action_combat.rs`, `combat.rs`, `hazards.rs`, `phase_six.rs`). */
const EFFECT = Object.freeze({ slash: 55, slashReach: 30, shock: 130, scan: 450, upgrade: 75, loot: 30, rail: 60, charge: 70, grapple: 35 });
const STATUS: Record<Actor['presence'], PlayerStatus> = {
  pending: 'respawning', active: 'active', eliminated: 'eliminated', escaped: 'escaped', transit: 'transit', stranded: 'stranded',
};

/** What a ground record carries that the core does not: generation metadata, kept by ID. */
type Metadata = Pick<GroundItem, 'nodeId' | 'tier'>;
/** Per player, whether it started with the optional records the core always has. */
interface Shape { inventory: boolean; reserves: boolean }

/** What the mapping needs besides the core's records: the IDs and what the start fixed. */
export interface Context {
  ids: MatchIds; metadata: ReadonlyMap<number, Metadata>; shapes: ReadonlyMap<number, Shape>; blast: number;
  grid: { cols: number; rows: number };
  /** Whether the content keeps discovery. Off, contestants keep no memory, as the old game attaches none. */
  discovery: boolean;
  /** Tiered content displays weapon quality even at its base tier. */
  weaponQuality: boolean;
}

/** The context of a match set up from `s`, read from the game as the loader left it, before the first step. */
export function contextOf(s: Game, match: TickMatch): Context {
  const metadata = new Map<number, Metadata>();
  for (const item of s.items) metadata.set(item.id, { nodeId: item.nodeId, tier: item.tier });
  const shapes = new Map(s.players.map((p, slot) => [match.ids.actorAtSlot[slot]!, { inventory: p.inventory !== undefined, reserves: p.reserves !== undefined }] as const));
  return { ids: match.ids, metadata, shapes, blast: s.content.traps.mine.blast, grid: discoveryGrid(s.map),
    discovery: s.content.discovery === true, weaponQuality: s.content.lootTiers !== undefined };
}

export const remaining = (deadline: Tick, tick: Tick): Tick => Math.max(0, deadline - tick);
/** A status window as a countdown at `tick`: the old field is in effect at T while `T < tick + v`. */
function windowLeft(window: Window | undefined, tick: Tick): Tick {
  if (!window) return 0;
  if (window.activeFrom > tick + 1) throw new RangeError(`tick-records: a window from ${window.activeFrom} is not yet in effect at ${tick + 1}`);
  return remaining(window.expiresAt, tick);
}

/** Write `value`, or drop the key for undefined, so an absent field stays absent as the old rules leave it. */
function set<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key]; else target[key] = value;
}

function equipmentFields(e: Equipment, weaponQuality: boolean): Pick<InventoryItem, 'kind'> & Record<string, unknown> {
  const quality = e.quality === 1 && !(weaponQuality && e.kind.kind === 'firearm') ? {} : { quality: e.quality };
  switch (e.kind.kind) {
    case 'firearm': return { kind: 'weapon', weaponType: e.kind.weapon, ammo: e.kind.rounds, ...quality };
    case 'cell': return { kind: 'cell', charge: e.kind.charge, ...quality };
    case 'stack': return { kind: e.kind.utility === 'medkit' ? 'med' : 'shield', count: e.kind.count, ...quality };
  }
}
function lootFields(loot: Loot, weaponQuality: boolean): Record<string, unknown> {
  switch (loot.kind) {
    case 'accessKey': return { kind: 'access' };
    case 'ammo': return { kind: 'ammo', family: loot.family, count: loot.count };
    case 'equipment': return equipmentFields(loot.equipment, weaponQuality);
  }
}
const carriedOf = (c: CarriedItem, weaponQuality: boolean): InventoryItem => ({ ...equipmentFields(c.equipment, weaponQuality), instanceId: c.id, lineageId: c.lineage }) as InventoryItem;

/** A ground record at `at`: its body's pose when placed, else where it waits. */
export function groundOf(ctx: Context, id: number, item: CoreGround, at: Point): GroundItem {
  const record = { id, x: at[0], y: at[1], ...lootFields(item.loot, ctx.weaponQuality) } as GroundItem & Record<string, unknown>;
  if (item.lineage !== null) record.lineageId = item.lineage as never;
  if (item.droppedBy !== null) record.droppedBy = ctx.ids.playerOfActor.get(item.droppedBy);
  if (item.pickupReadyAt > 0) record.pickupAfter = item.pickupReadyAt;
  const meta = ctx.metadata.get(id);
  if (item.building != null) record.buildingId = ctx.ids.buildingIds[item.building];
  if (meta) for (const key of ['nodeId', 'tier'] as const) if (meta[key] !== undefined) (record as Record<string, unknown>)[key] = meta[key];
  return record;
}

/** The player fields an actor record stands for, at tick `tick`, written onto `p` (a player, a frame record or a blank). */
export function writeActor(ctx: Context, p: Partial<Player>, word: number, a: Actor, tick: Tick): void {
  const ids = ctx.ids, shape = ctx.shapes.get(word)!;
  p.status = STATUS[a.presence];
  p.level = a.level; p.kills = a.kills; p.hp = a.hp; p.maxHp = a.maxHp; p.shield = a.shield; p.heading = a.aim; p.bot = a.bot;
  set(p, 'viewLagTicks', a.viewLag > 0 ? a.viewLag : undefined);
  const inv = a.inventory;
  if (shape.inventory) {
    p.inventory = inv.slots.map(slot => slot ? carriedOf(slot, ctx.weaponQuality) : null);
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
/** An actor's countdown fields at `tick`, from its deadlines. */
export function countdowns(p: Partial<Player>, a: Actor, tick: Tick): void {
  p.cooldown = remaining(a.deadlines.skillReadyAt, tick);
  p.attackCd = remaining(a.deadlines.weaponReadyAt, tick);
  p.railCd = remaining(a.deadlines.transitReadyAt, tick);
  p.boost = windowLeft(a.statuses.boost, tick);
  p.cloak = windowLeft(a.statuses.cloak, tick);
  p.revealed = windowLeft(a.statuses.reveal, tick);
  p.stun = windowLeft(a.statuses.stun, tick);
}

/** A trap's dynamic fields at `tick`, written onto its record. Its static fields stay the record's. */
export function writeTrap(ctx: Context, trap: Trap, t: CoreTrap, tick: Tick): void {
  trap.x = t.position[0]; trap.y = t.position[1]; trap.heading = t.heading; trap.cooldown = remaining(t.readyAt, tick);
  const k = t.kind;
  if (k.kind === 'mine') trap.spent = k.spent;
  else if (k.kind === 'turret') trap.aiming = k.aiming;
  else if (k.kind === 'flame') { trap.warning = k.warning; trap.firing = k.firing; }
  else { trap.homeX = k.home[0]; trap.homeY = k.home[1]; trap.targetId = k.target === null ? null : ctx.ids.playerOfActor.get(k.target)!; }
}

export function projectileOf(ctx: Context, id: number, p: CoreProjectile, tick: Tick): Projectile {
  const source = p.source, trap = source.kind === 'trap';
  const owner = trap ? ctx.ids.trapIds[source.id]! : ctx.ids.playerOfActor.get(source.id)!;
  return { id, owner, ...(trap ? { trap: true } : {}), x: p.position[0], y: p.position[1], dx: p.velocity[0], dy: p.velocity[1],
    life: remaining(p.expiresAt, tick), damage: p.damage };
}

/** Where a tick's presentation goes (`event-records.ts`): its effects and events, each taking its ID from `serial`. */
export type { Stage } from './event-records.ts';
import type { Stage } from './event-records.ts';
/** What the facts name, at the committed poses: an actor's place, aim and participant, and a trap's place. */
export interface Cast {
  actor(word: number): Vec2 & { heading: number };
  participant(word: number): EventParticipant;
  trap(index: number): Vec2;
  blast: number;
}

/**
 * Age the stage's effects by one tick, then present T's facts on it. Returns whether the match finished. `escaped` gives
 * `pod_powered` with the slots left after that escape; `eliminated` takes its source from T's `killCredited`.
 */
export function present(stage: Stage, facts: readonly Fact[], cast: Cast): boolean {
  for (const e of stage.effects) e.life--;
  stage.effects = stage.effects.filter(e => e.life > 0);
  const credited = new Map<number, number>();
  let finished = false;
  for (const f of facts) if (f.kind === 'killCredited') credited.set(f.target, f.actor);
  for (const f of facts) {
    switch (f.kind) {
      case 'escaped': event(stage, { kind: 'pod_powered', actor: cast.participant(f.actor), slotsRemaining: f.slots }); break;
      case 'cellCharged': event(stage, { kind: 'cell_charged', actor: cast.participant(f.actor) }); effect(stage, cast.actor(f.actor), 'charge', EFFECT.charge); break;
      case 'eliminated': {
        const source = credited.get(f.actor);
        event(stage, { kind: 'eliminated', target: cast.participant(f.actor), ...(source !== undefined ? { source: cast.participant(source) } : {}) });
        break;
      }
      case 'respawned': event(stage, { kind: 'respawned', actor: cast.participant(f.actor) }); break;
      case 'finished': event(stage, { kind: 'match_finished' }); finished = true; break;
      case 'meleeSwung': {
        const p = cast.actor(f.actor);
        effect(stage, { x: p.x + cos(p.heading) * EFFECT.slashReach, y: p.y + sin(p.heading) * EFFECT.slashReach }, 'slash', EFFECT.slash);
        break;
      }
      case 'wardenPulsed': effect(stage, cast.actor(f.actor), 'shock', EFFECT.shock); break;
      case 'specterScanned': effect(stage, cast.actor(f.actor), 'scan', EFFECT.scan); break;
      case 'boosted': effect(stage, cast.actor(f.actor), 'upgrade', EFFECT.upgrade); break;
      case 'utilityUsed': case 'pickup': effect(stage, cast.actor(f.actor), 'loot', EFFECT.loot); break;
      case 'transitDeparted': case 'transitLanded': effect(stage, cast.actor(f.actor), 'rail', EFFECT.rail); break;
      case 'mineExploded': effect(stage, cast.trap(f.trap), 'shock', cast.blast); break;
      case 'spiderGrappled': effect(stage, { x: f.at[0], y: f.at[1] }, 'grapple', EFFECT.grapple); break;
      default: break;
    }
  }
  return finished;
}

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

/** The participant a player is in an event: its roster place and name. */
export const participantOf = (playerIdx: number, p: Pick<Player, 'name'>): EventParticipant => ({ playerIdx: playerIdx as never, name: p.name });
