import { templatesOf } from './boundary.ts';
import { authoredProps } from './world-physics.ts';
import { compactItems, omitBodyPose } from '../relational-frame.ts';
import { settledLayer } from '../frame-layers.ts';
import { shareGatePublication } from './frame-gates.ts';
import { addItemsFromCore, groundItem, indexGround, publishItems, removeItem, replaceItem, shareItemPublication } from './ground-items.ts';
import { bodyKey, bodyOrder } from './tick-codec.ts';
import { event } from './event-records.ts';
import { BodyLives, contextOf, groundOf, participantOf, present, projectileOf, writeActor, writeTrap } from './tick-records.ts';
import type { FramePresentation } from './visibility.ts';
import type { BodyShape, NumericHookFlight, NumericPhysicsBody, NumericPhysicsTether, PhysicsBodyOwner } from '../physics/types.ts';
import type { Actor, BodyRef, DecodedTick, Hook, Inbound, Point, PoseEntry, Projectile as CoreProjectile, Snapshot as CoreSnapshot, Tick,
  Trap as CoreTrap } from './tick-codec.ts';
import type { BodyLife, Cast, Context, Stage } from './tick-records.ts';
import type { TickMatch } from './tick-match.ts';
import type { BodyId, Effect, Game, GameEvent, GameEventPayload, GateIdx, GateState, GroundItem, ItemId, Player, PlayerIdx, PropId, Snapshot, TetherId, Trap } from '../types.ts';

// The new tick's frames (docs/27.2 "Frames"), built from the core's output: the `Snapshot` the recording writer stores and
// `playerView` projects. The store follows the match's completed ticks (`TickMatch.follow`) and keeps the records it last
// received, so the frame of a tick is the previous one with that tick's change list applied (27.2 "Output (3c)"). It does
// not read the `Game` mirror (#1284). From the game it reads only what the core does not hold:
// - at the start, the content's constants, the traps' static fields, the order of the map's loot, and where an actor
//   without a body stands;
// - each frame, the roster's identity (name, role, kit, seat) and the receive boundary's per-player state (`lastSeq`,
//   `inputStalled`, `inputMargin`, `inputLeadTicks`), which `tick-boundary.ts` keeps on the player.
//
// - **Players** are written in one order (`PLAYER_ORDER`), so a frame's JSON does not depend on the history of writes.
//   The boundary's internals (its queue and sequence counters) are not frame fields.
// - **Body identity and generations** are `BodyLives`: a new ID per lifetime, a generation within it renewed by a warp,
//   and `placed` on the tick a body enters the world.
// - **Shapes** are the specs the loader uploads: the actor templates, the loot template and the authored props, copied
//   once and frozen, so no frame can change another's or what the loader uploads.
// - **Tethers** are the hooks pulling, from caster (`a`) to target (`b`); **flights** are the hooks flying. A tether's ID
//   is the hook's ID, which the core allocates from 1 and keeps for the hook's life (review 1047).
// - **No private `physics` block**, RNG or scatter serial: the new tick keeps none (review 1047).

type Shape = Readonly<BodyShape>;

/** A detached, frozen copy of a shape, its vertices included. */
function frozenShape(shape: BodyShape): Shape {
  return Object.freeze(shape.kind === 'convex'
    ? { kind: 'convex', vertices: Object.freeze(shape.vertices.map(v => Object.freeze({ x: v.x, y: v.y }))) } as BodyShape
    : { ...shape });
}

/** A frame player's fields, in order. Absent optional fields are left out. */
const PLAYER_ORDER = ['id', 'name', 'role', 'kit', 'bot', 'x', 'y', 'hp', 'maxHp', 'shield', 'keys', 'weapon', 'kills', 'level', 'status',
  'cooldown', 'attackCd', 'railCd', 'cloak', 'revealed', 'boost', 'stun', 'heading', 'input', 'lastSeq', 'seat', 'inventory', 'selectedSlot',
  'reserves', 'inputStalled', 'inputMargin', 'inputLeadTicks', 'viewLagTicks', 'reload', 'charging', 'respawnAt', 'transit', 'aggressor',
  'aggressionUntil'] as const;
/** What a frame player takes from the roster and the receive boundary, not from the core. */
const ROSTER = new Set(['name', 'role', 'kit', 'seat', 'lastSeq', 'inputStalled', 'inputMargin', 'inputLeadTicks']);

/** A whole state's records, as the store keeps them and as a snapshot maps (`recordsOf`), comparable field by field. */
export interface FrameRecords {
  tick: Tick;
  players: Record<string, unknown>[];
  items: GroundItem[];
  projectiles: ReturnType<typeof projectileOf>[];
  gates: { open: boolean; locked: boolean }[];
  traps: Trap[];
  slots: number;
  hazardX: number;
}

/** The ground list holder the ground-list helpers edit: the store's own, never the game's. */
type Ground = Pick<Game, 'items'>;

/** The frames of one match. Construct it on the game the match was set up from, before the first step. */
export class TickFrames {
  readonly s: Game;
  readonly match: TickMatch;
  readonly ctx: Context;
  readonly #shapes: { actor: Record<'contestant' | 'gladiator', Shape>; loot: Shape; props: Shape[] };
  #tick: Tick;
  /** The last actor record received per actor word, and where each actor last stood. */
  readonly #actors = new Map<number, Actor>();
  readonly #at = new Map<number, Point>();
  readonly #ground: Ground = { items: [] };
  #itemSerial: number | undefined;
  readonly #projectiles = new Map<number, CoreProjectile>();
  /** Each trap's static fields, from the game, and its last core record. */
  readonly #trapBase: readonly Trap[];
  readonly #traps: CoreTrap[] = [];
  readonly #gates: { open: boolean; locked: boolean }[];
  #gateList: GateState[] | null = null;
  #slots: number;
  #hazardX: number;
  #phase: Game['phase'];
  /** Contestants the room stranded when it ended the match. */
  readonly #stranded = new Set<number>();
  /**
   * Seat changes queued for a tick not yet completed, by actor word. The receive boundary hands a seat over at once, so
   * a frame captured before that tick shows the seat as the tick will leave it: under its new controller, its lag and
   * held input cleared, as the core clears them on the observation. The completed tick's records replace it (review 1102).
   */
  readonly #seats = new Map<number, { tick: Tick; kind: 'join' | 'leave' }>();
  readonly #stage: Stage;
  readonly #cast: Cast;
  /** Hooks and every dynamic body's whole pose (keyed `kind:id`) and lifetime. */
  readonly hooks = new Map<number, Hook>();
  readonly poses = new Map<string, PoseEntry>();
  readonly lives = new BodyLives();

  constructor(s: Game, match: TickMatch) {
    this.s = s; this.match = match;
    const ctx = this.ctx = contextOf(s, match), t = templatesOf(s);
    this.#shapes = { actor: { contestant: frozenShape(t.actor.contestant.shape), gladiator: frozenShape(t.actor.gladiator.shape) },
      loot: frozenShape(t.loot.shape), props: authoredProps(s).map(p => frozenShape(p.spec.shape)) };
    const snap = match.snapshot(), at = poseMap(snap.poses);
    this.#tick = snap.tick;
    for (const e of snap.state.actors) {
      this.#actors.set(e.word, e.actor);
      const p = s.players[ctx.ids.slotOfActor.get(e.word)!]!;
      this.#at.set(e.word, at.get(`actor:${e.word}`) ?? [p.x, p.y]);
      this.#carried(e.actor);
    }
    // The map's loot in the game's order, then any record only the core holds.
    const byId = new Map(snap.state.items.map(e => [e.id, e] as const)), ground: GroundItem[] = [];
    const place = (id: number, fallback?: Point) => {
      const e = byId.get(id)!;
      ground.push(groundOf(ctx, id, e.item, at.get(`item:${id}`) ?? e.item.unplacedAt ?? fallback!));
      byId.delete(id);
    };
    for (const item of s.items) if (byId.has(item.id)) place(item.id, [item.x, item.y]);
    for (const id of [...byId.keys()]) place(id);
    addItemsFromCore(this.#ground as Game, ground);
    // Published first, so the records are frozen and enter their cells now; a mutable record would wait loose and move
    // to its cell on the first query, one search of the loose list per record (review 1102).
    indexGround(publishItems(this.#ground as Game));
    this.#itemSerial = s.itemSerial;
    this.#trapBase = s.traps.map(trap => Object.freeze({ ...trap }));
    for (const e of snap.state.traps) this.#traps[e.id] = e.trap;
    this.#gates = s.gates.map(() => ({ open: false, locked: false }));
    for (const e of snap.state.gates) this.#gates[e.id] = { open: e.gate.open, locked: e.gate.locked };
    this.#slots = snap.state.extraction?.slots ?? s.slots;
    this.#hazardX = snap.state.hazardX ?? s.hazardX;
    this.#phase = s.phase;
    this.#stage = { tick: snap.tick, serial: s.serial, effects: structuredClone(s.effects), events: structuredClone(s.events) };
    this.#cast = {
      actor: word => { const [x, y] = this.#at.get(word)!; return { x, y, heading: this.#actors.get(word)!.aim }; },
      participant: word => { const slot = ctx.ids.slotOfActor.get(word)!; return participantOf(slot, s.players[slot]!); },
      trap: index => { const [x, y] = this.#traps[index]!.position; return { x, y }; },
      blast: ctx.blast,
    };
    for (const pose of snap.poses) this.poses.set(bodyKey(pose.body), pose);
    this.lives.start(snap.poses.map(p => bodyKey(p.body)));
    for (const e of snap.state.hooks) this.hooks.set(e.id, e.hook);
    for (const e of snap.state.projectiles) this.#projectiles.set(e.id, e.projectile);
    match.follow(t => this.take(t), (tick, rows) => this.#queued(tick, rows));
  }

  /** Rows the match queued for `tick`: a join or leave is a seat change the frame shows until that tick completes. */
  #queued(tick: Tick, rows: readonly Inbound[]): void {
    for (const row of rows) if (row.type === 'observation' && (row.observation.kind === 'join' || row.observation.kind === 'leave'))
      this.#seats.set(row.observation.actor, { tick, kind: row.observation.kind });
  }

  #serial(id: number): void { if (this.#itemSerial === undefined || this.#itemSerial <= id) this.#itemSerial = id + 1; }
  #carried(a: Actor): void { for (const slot of a.inventory.slots) if (slot) this.#serial(slot.id); }

  /** Apply one completed tick: changed records whole, removals, poses and lifetimes, then T's facts. */
  take(t: DecodedTick): void {
    const ctx = this.ctx, c = t.changes, tick = t.tick, ground = this.#ground as Game, at = poseMap(c.poses);
    this.#tick = tick;
    for (const [word, seat] of this.#seats) if (seat.tick <= tick) this.#seats.delete(word);
    for (const e of c.actors) { this.#actors.set(e.word, e.actor); this.#carried(e.actor); }
    // A gate record that names a gate without changing it keeps the published list shared.
    for (const e of c.gates) {
      const was = this.#gates[e.id]!;
      if (was.open === e.gate.open && was.locked === e.gate.locked) continue;
      this.#gates[e.id] = { open: e.gate.open, locked: e.gate.locked };
      this.#gateList = null;
    }
    for (const e of c.traps) this.#traps[e.id] = e.trap;
    if (c.extraction) this.#slots = c.extraction.slots;
    if (c.hazardX !== null) this.#hazardX = c.hazardX;
    for (const gone of c.removed) {
      if (gone.kind === 'item') { const item = groundItem(ground, gone.id as ItemId); if (item) removeItem(ground, item, true); }
      else if (gone.kind === 'projectile') this.#projectiles.delete(gone.id);
      else if (gone.kind === 'hook') this.hooks.delete(gone.id);
    }
    // A body that moved with its record unchanged keeps the record and takes the pose. A pose that changed only its
    // rotation, motion or sleep leaves the published record alone.
    const changed = new Map(c.items.map(e => [e.id, e.item] as const));
    for (const pose of c.poses) if (pose.body.kind === 'item' && !changed.has(pose.body.id)) {
      const old = groundItem(ground, pose.body.id as ItemId);
      if (old && (old.x !== pose.at[0] || old.y !== pose.at[1])) replaceItem(ground, old, { ...old, x: pose.at[0], y: pose.at[1] }, true);
    }
    for (const [id, record] of changed) {
      const old = groundItem(ground, id as ItemId), pose = at.get(`item:${id}`);
      const position = record.unplacedAt ?? pose ?? (old ? [old.x, old.y] as Point : undefined);
      if (!position) throw new RangeError(`tick-frame: ground item ${id} is placed with no pose`);
      const next = groundOf(ctx, id, record, position);
      if (old) replaceItem(ground, old, next, true); else addItemsFromCore(ground, [next]);
      this.#serial(id);
    }
    for (const e of c.projectiles) this.#projectiles.set(e.id, e.projectile);
    for (const e of c.hooks) this.hooks.set(e.id, e.hook);
    for (const marker of t.discontinuities) if (marker.kind === 'removed') this.poses.delete(bodyKey(marker.body));
    this.lives.take(t.discontinuities);
    for (const pose of c.poses) {
      this.poses.set(bodyKey(pose.body), pose);
      if (pose.body.kind === 'actor') this.#at.set(pose.body.id, pose.at);
    }
    this.#stage.tick = tick;
    if (present(this.#stage, c.events.map(e => e.fact), this.#cast)) this.#phase = 'finished';
  }

  /** A roster place's outward label changed: ground records name their dropper by label, so they follow it. */
  relabel(previous: Player['id'], next: Player['id']): void {
    const ground = this.#ground as Game;
    for (const item of [...ground.items]) if (item.droppedBy === previous) replaceItem(ground, item, { ...item, droppedBy: next }, true);
  }

  /** A scenario's event on the last completed tick's frame, as if the tick had produced it: tests arrange with it. */
  arrangeEvent(payload: GameEventPayload): void { event(this.#stage, payload); }

  /** The room ended the match: it is finished, and with `strand` its active contestants are stranded. */
  end({ strand = false } = {}): void {
    this.#phase = 'finished';
    if (strand) for (const [word, a] of this.#actors)
      if (a.presence === 'active' && this.s.players[this.ctx.ids.slotOfActor.get(word)!]!.role === 'contestant') this.#stranded.add(word);
  }

  /** The frame of the match's last completed tick. */
  frame(): Snapshot {
    const s = this.s, presentation = this.presentation(), records = this.records();
    const ground = publishItems(this.#ground as Game), items = compactItems(ground, presentation.bodies);
    shareItemPublication(ground, items);
    const actorBodies = new Set(presentation.bodies.flatMap(b => b.owner.kind === 'actor' ? [b.owner.playerIdx] : []));
    const players = records.players.map((p, i) => ({ ...(actorBodies.has(i as PlayerIdx) ? omitBodyPose(p) : p), playerIdx: i as PlayerIdx }));
    const stage = this.#stage;
    return { version: s.version, duration: s.content.durationTicks, cellChargeTicks: s.content.cellChargeTicks, tick: this.#tick,
      phase: this.#phase, hazardX: this.#hazardX, slots: this.#slots, serial: stage.serial, players, items, gates: this.#publishedGates(),
      traps: records.traps, projectiles: records.projectiles, effects: stage.effects.map(e => ({ ...e })) as Effect[],
      events: structuredClone(stage.events) as GameEvent[], ...(this.#itemSerial !== undefined ? { itemSerial: this.#itemSerial } : {}),
      physicsProfile: presentation.physicsProfile, bodies: presentation.bodies, tethers: presentation.tethers, hookFlights: presentation.hookFlights,
    } as unknown as Snapshot;
  }

  /** The gates as frames carry them: dynamic state only, shared from frame to frame until one changes. */
  #publishedGates(): GateState[] {
    if (!this.#gateList) {
      this.#gateList = this.#gates.map((g, i) => Object.freeze({ gateIdx: i as GateIdx, open: g.open, locked: g.locked }));
      settledLayer(this.#gateList); shareGatePublication(this.#gateList);
    }
    return this.#gateList;
  }

  /** Private diagnostic snapshot, with remaining bot routes read from the core on request. */
  privateFrame(): Snapshot {
    const frame = this.frame();
    const slots = this.ctx.ids.slotOfActor;
    for (const { actor, route } of this.match.botRoutes()) {
      const slot = slots.get(actor)!;
      const player = frame.players[slot]!;
      const fields = Object.entries(player);
      // Routes precede the fields only some players have.
      const at = fields.findIndex(([key]) => key === 'transit' || key === 'aggressor' || key === 'playerIdx');
      fields.splice(at < 0 ? fields.length : at, 0, ['route', route]);
      frame.players[slot] = Object.fromEntries(fields) as typeof player;
    }
    return frame;
  }

  /** The store's records, whole: the players (bodiless ones at their last place), the ground in its order, the rest by ID. */
  records(): FrameRecords {
    const tick = this.#tick, ctx = this.ctx;
    return {
      tick,
      players: this.s.players.map((p, slot) => this.#player(slot, this.#actors.get(ctx.ids.actorAtSlot[slot]!)!, this.#at.get(ctx.ids.actorAtSlot[slot]!))),
      items: [...this.#ground.items],
      projectiles: [...this.#projectiles].sort((a, b) => a[0] - b[0]).map(([id, p]) => projectileOf(ctx, id, p, tick)),
      gates: this.#gates.map(g => ({ ...g })),
      traps: this.#trapBase.map((base, i) => this.#trap(base, this.#traps[i], tick)),
      slots: this.#slots, hazardX: this.#hazardX,
    };
  }

  /**
   * A whole core snapshot mapped as the store maps changes: the oracle a test holds `records` equal to. The ground is in
   * ID order, so compare it sorted; an actor without a body has no place here.
   */
  recordsOf(snap: CoreSnapshot): FrameRecords {
    const ctx = this.ctx, at = poseMap(snap.poses), tick = snap.tick;
    const actors = new Map(snap.state.actors.map(e => [e.word, e.actor] as const));
    return {
      tick,
      players: this.s.players.map((p, slot) => this.#player(slot, actors.get(ctx.ids.actorAtSlot[slot]!)!, at.get(`actor:${ctx.ids.actorAtSlot[slot]}`), tick)),
      items: snap.state.items.map(e => groundOf(ctx, e.id, e.item, e.item.unplacedAt ?? at.get(`item:${e.id}`)!)),
      projectiles: snap.state.projectiles.map(e => projectileOf(ctx, e.id, e.projectile, tick)),
      gates: snap.state.gates.map(e => ({ open: e.gate.open, locked: e.gate.locked })),
      traps: snap.state.traps.map(e => this.#trap(this.#trapBase[e.id]!, e.trap, tick)),
      slots: snap.state.extraction?.slots ?? this.#slots, hazardX: snap.state.hazardX ?? this.#hazardX,
    };
  }

  /** A trap at `tick`: its static fields and its core record's. */
  #trap(base: Trap, core: CoreTrap | undefined, tick: Tick): Trap {
    const trap = { ...base };
    if (core) writeTrap(this.ctx, trap, core, tick);
    return trap;
  }

  /** A frame player: the roster's and boundary's fields, the actor's at `tick`, and its place when given, in `PLAYER_ORDER`. */
  #player(slot: number, a: Actor, at: Point | undefined, tick = this.#tick): Record<string, unknown> {
    const roster = this.s.players[slot]!, word = this.ctx.ids.actorAtSlot[slot]!, core: Partial<Player> = {};
    writeActor(this.ctx, core, word, a, tick);
    if (this.#stranded.has(word)) core.status = 'stranded';
    const seat = tick === this.#tick ? this.#seats.get(word) : undefined;
    if (seat) { core.bot = seat.kind === 'leave'; delete core.viewLagTicks; }
    const fields: Record<string, unknown> = { ...core, id: this.ctx.ids.playerOfActor.get(word), input: seat ? {} : { sneak: a.sneak } };
    if (at) { fields.x = at[0]; fields.y = at[1]; }
    if (core.weapon === undefined) fields.weapon = roster.weapon;
    const out: Record<string, unknown> = {};
    for (const key of PLAYER_ORDER) {
      const value = ROSTER.has(key) ? roster[key as keyof Player] : fields[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** The physics presentation of the last completed tick, in body order. */
  presentation(): FramePresentation & { bodies: NumericPhysicsBody[]; tethers: NumericPhysicsTether[]; hookFlights: NumericHookFlight[] } {
    const roster = this.ctx.ids.slotOfActor;
    const bodies: NumericPhysicsBody[] = [], actorBody = new Map<number, BodyId>();
    for (const pose of [...this.poses.values()].sort((a, b) => bodyOrder(a.body, b.body))) {
      const key = bodyKey(pose.body), life = this.lives.get(key);
      if (!life) throw new RangeError(`tick-frame: ${key} has a pose and no lifetime`);
      const described = this.#describe(pose.body, roster);
      if (!described) continue;
      if (pose.body.kind === 'actor') actorBody.set(pose.body.id, life.id);
      bodies.push(bodyOf(life, described, pose, this.lives.placed(key)));
    }
    const tethers: NumericPhysicsTether[] = [], hookFlights: NumericHookFlight[] = [];
    for (const [id, hook] of [...this.hooks].sort((a, b) => a[0] - b[0])) {
      const a = actorBody.get(hook.owner), tether = id as TetherId;
      if (a === undefined) continue;
      if (hook.phase.kind === 'pulling') {
        const b = actorBody.get(hook.phase.target);
        if (b !== undefined) tethers.push({ id: tether, a, b });
      } else hookFlights.push({ id: tether, a, casterIdx: roster.get(hook.owner)!, x: hook.phase.position[0], y: hook.phase.position[1] });
    }
    return { physicsProfile: this.s.version, bodies, tethers, hookFlights };
  }

  /** A body's kind, shape and owner, or null for one the frame does not draw. */
  #describe(body: BodyRef, roster: ReadonlyMap<number, PlayerIdx>): Described | null {
    switch (body.kind) {
      case 'actor': {
        const playerIdx = roster.get(body.id);
        if (playerIdx === undefined) return null;
        return { kind: 'actor', shape: this.#shapes.actor[this.s.players[playerIdx]!.role], owner: { kind: 'actor', playerIdx } };
      }
      case 'item': return { kind: 'prop', shape: this.#shapes.loot, owner: { kind: 'item', itemId: body.id as ItemId } };
      case 'prop': {
        const shape = this.#shapes.props[body.id];
        if (!shape) throw new RangeError(`tick-frame: prop ${body.id} is not authored`);
        return { kind: 'prop', shape, owner: { kind: 'prop', propId: body.id + 1 as PropId } };
      }
      default: return null;
    }
  }
}

type Described = { kind: 'actor' | 'prop'; shape: Shape; owner: PhysicsBodyOwner };

/** A presentation body, in the old capture's field order, so a frame's JSON reads as the old one did. */
function bodyOf(life: BodyLife, d: Described, pose: PoseEntry, placed: boolean): NumericPhysicsBody {
  return { id: life.id, kind: d.kind, shape: d.shape as BodyShape, x: pose.at[0], y: pose.at[1], angle: pose.angle, vx: pose.velocity[0], vy: pose.velocity[1],
    omega: pose.spin, sleeping: pose.sleeping, generation: life.generation, owner: d.owner, ...(placed ? { discontinuity: 'placed' as const } : {}) };
}

function poseMap(poses: readonly PoseEntry[]): Map<string, Point> {
  return new Map(poses.map(p => [bodyKey(p.body), p.at] as const));
}
