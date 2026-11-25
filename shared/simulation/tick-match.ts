import { AMMO_FAMILIES, WEAPONS } from '../enum-tables.ts';
import { DISCOVERY_CELL_SIZE } from '../discovery.ts';
import { MOVEMENT_SPEED } from '../movement.ts';
import { templateRow } from '../physics/world.ts';
import type { BodySpec } from '../physics/types.ts';
import { UTILITY_RULES } from './action-records.ts';
import { templatesOf } from './boundary.ts';
import { OVERDRIVE_TICKS } from './combat.ts';
import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { HZ } from './rules.ts';
import { sightOf } from './sight-runtime.ts';
import { discoveryTables } from '../discovery.ts';
import { authoredProps } from './world-physics.ts';
import { createRuntimeNavigation } from '../navigation/runtime-map.ts';
import { SLOT_COUNT, actorWord, decodeBotRoutes, decodeCompleted, decodeCues, decodeMemory, decodeSnapshot, encodeInbound, encodeSetup } from './tick-codec.ts';
import type { Actor, ActorEntry, Presence, Window, BodyRow, SetupBody, DecodedTick, Equipment, GateEntry, GroundEntry, Inbound, Loot, MatchSetup, Memory, MotorSurface, Cue, BotLabel,
  Point, Snapshot, State, StationEntry, Tick, TrapEntry, TrapKind, Tuning, WeaponTuning } from './tick-codec.ts';
import type { CoreExports } from '../core.ts';
import type { ChargerId, Game, GateId, InventoryItem, Kit, Player, PlayerId, PlayerIdx, PlayerStatus, StationId, TrapId, WeaponType } from '../types.ts';

// The loader half of the live adapter (docs/27.2 "Live adapter (3d.1)"): a freshly created `Game` mapped into the new
// tick's record shapes (`rust/core/src/tick/state.rs`) and the setup a `tick::Match` starts from. It produces plain
// typed objects; the encoder that serializes them into the codec's words (`tick/codec.rs`) is separate. It is a
// match-start loader: a game that has run, or holds anything the new state cannot, is refused.

/** What the setup's numbers stand for, both ways. */
export interface MatchIds {
  /** Core actor identities stay tied to their roster slots when a new connection takes over. */
  actorAtSlot: readonly number[];
  slotOfActor: ReadonlyMap<number, PlayerIdx>;
  actorOfPlayer: ReadonlyMap<PlayerId, number>;
  playerOfActor: ReadonlyMap<number, PlayerId>;
  bindPlayer(slot: PlayerIdx, id: PlayerId): void;
  buildingIds: readonly import('../types.ts').BuildingId[];
  gateIndex: ReadonlyMap<GateId, number>;
  gateIds: readonly GateId[];
  trapIndex: ReadonlyMap<TrapId, number>;
  trapIds: readonly TrapId[];
  /** Station numbers: chargers first, then transit stations, each in map order. */
  chargerIndex: ReadonlyMap<ChargerId, number>;
  transitIndex: ReadonlyMap<StationId, number>;
  stations: readonly ({ kind: 'charging'; id: ChargerId } | { kind: 'transit'; id: StationId })[];
  /** Prop number to authored label, in the old world's admission (ID) order. */
  propNumber: ReadonlyMap<string, number>;
  propLabels: readonly string[];
  /** Geometry number to body ID, in `buildPhysicsGeometry`'s order after `createGame`'s ID sort. */
  geometryNumber: ReadonlyMap<string, number>;
  geometryIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/**
 * The new tick's dynamic-body ceiling (`MAX_DYNAMIC` in `rust/core/src/world.rs`), which `DropTuning::default` takes for the
 * body and optional body capacities. The old tick has no field for either; its `worldPhysics.dropReserve` is `dropReserve`.
 */
export const DYNAMIC_BODY_CAPACITY = 128;
/** `ItemRules`' and `Inventory`'s baked tables (`tick/inventory.rs`, `tick/combat.rs`), which content must equal. */
const BAKED = Object.freeze({
  weaponCapacity: [192, 360, 96], magazine: [12, 30, 6], reserveCapacity: [72, 120, 30], reloadTicks: [20, 30, 30],
  qualityDamage: [1, 1.08, 1.16, 1.24, 1.32], discoveryCell: 192,
});

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Encode the label-dependent bot ties when a persistent seat gets its current label. */
export function botLabel(labels: Iterable<PlayerId>, id: PlayerId): BotLabel {
  let rank = 0;
  for (const label of labels) if (label < id) rank++;
  return { rank, opportunistic: id.charCodeAt(id.length - 1) % 3 === 0 };
}
const pointOf = (at: { x: number; y: number }): Point => [at.x, at.y];

const PRESENCE: Record<PlayerStatus, Presence> = {
  active: 'active', eliminated: 'eliminated', escaped: 'escaped', stranded: 'stranded', transit: 'transit', respawning: 'pending',
};

function refuse(why: string): never { throw new RangeError(`tick-match: ${why}`); }

/** A contestant's kit is inert in the old tick (skills and melee are gladiator-only, `action_combat.rs`'s `p.role == 0.0` return), and the new tick's `Kit` is `None` for them (`tick/tests.rs`). */
const kitOf = (p: Player): Kit | null => p.role === 'gladiator' ? p.kit : null;

/**
 * A countdown field becomes a deadline at the game's tick: the old tick decrements in phase 1 of the tick it is about to run
 * (T = tick + 1) and a value reaching zero is ready in that same tick, so a countdown `v` is ready at T = tick + v, which is
 * what `tick >= ready_at` reads.
 */
const deadline = (tick: Tick, remaining: number | undefined): Tick => tick + (remaining !== undefined && remaining > 0 ? remaining : 0);
/**
 * A window for a status countdown `v > 0`: after phase 1 of T = tick + k the old value is `v - k` and the status is in effect
 * while it is above zero, that is while T < tick + v, which is `Window::contains` over [tick, tick + v).
 */
const windowOf = (tick: Tick, remaining: number | undefined): Window | undefined =>
  remaining !== undefined && remaining > 0 ? { activeFrom: tick, expiresAt: tick + remaining } : undefined;

/** A firearm: an omitted weapon type is a pistol and omitted rounds the content's, as `validateItemPayload` reads them. */
function weapon(s: Game, item: { weaponType?: WeaponType | undefined; ammo?: number | undefined }, quality: number): Equipment {
  const type = item.weaponType ?? 'pistol';
  return { quality, kind: { kind: 'firearm', weapon: type, rounds: item.ammo ?? s.content.weapons[type].ammo } };
}

function equipmentOf(s: Game, item: InventoryItem): Equipment {
  const quality = item.quality ?? 1;
  if (item.kind === 'weapon') return weapon(s, item, quality);
  if (item.kind === 'cell') return { quality, kind: { kind: 'cell', charge: item.charge } };
  return { quality, kind: { kind: 'stack', utility: item.kind === 'med' ? 'medkit' : 'shield', count: item.count } };
}

/** The loot a ground record stands for. */
function lootOf(s: Game, item: Game['items'][number]): Loot {
  const quality = item.quality ?? 1;
  switch (item.kind) {
    case 'access': return { kind: 'accessKey' };
    case 'ammo':
      if (item.family === undefined || item.count === undefined) refuse(`ground ammo ${item.id} lacks its family or count`);
      return { kind: 'ammo', family: item.family, count: item.count };
    case 'weapon': return { kind: 'equipment', equipment: weapon(s, item, quality) };
    case 'cell': return { kind: 'equipment', equipment: { quality, kind: { kind: 'cell', charge: item.charge ?? 0 } } };
    case 'med': case 'shield':
      return { kind: 'equipment', equipment: { quality, kind: { kind: 'stack', utility: item.kind === 'med' ? 'medkit' : 'shield', count: item.count ?? 1 } } };
  }
}

/** Refuse content the new tick bakes constants for, where they differ from the content's own. */
function checkBaked(s: Game): void {
  const c = s.content;
  WEAPONS.forEach((type, i) => {
    if (c.weapons[type].maxAmmo !== BAKED.weaponCapacity[i]) refuse(`${type} maxAmmo ${c.weapons[type].maxAmmo} differs from the new tick's ${BAKED.weaponCapacity[i]}`);
    const reload = c.reloading?.weapons[type];
    if (reload && (reload.magazine !== BAKED.magazine[i] || reload.reloadTicks !== BAKED.reloadTicks[i] || reload.family !== AMMO_FAMILIES[i]))
      refuse(`${type} reloading differs from the new tick's baked magazine, reload time or family`);
  });
  AMMO_FAMILIES.forEach((family, i) => {
    if (c.reloading && c.reloading.reserves[family] !== BAKED.reserveCapacity[i]) refuse(`${family} reserve capacity differs from the new tick's ${BAKED.reserveCapacity[i]}`);
  });
  if (c.lootTiers && !BAKED.qualityDamage.every((m, i) => c.lootTiers!.damage[i] === m)) refuse('loot tier damage differs from the new tick\'s multipliers');
  if (DISCOVERY_CELL_SIZE !== BAKED.discoveryCell) refuse('the discovery cell size differs from the new tick\'s');
  if (UTILITY_RULES.medHealth !== 40 || UTILITY_RULES.shieldAmount !== 30) refuse('utility amounts differ from the new tick\'s');
}

function tuningOf(s: Game): Tuning {
  const c = s.content, a = c.actorPhysics, h = c.hook, t = c.traps;
  const weapon = (type: WeaponType): WeaponTuning => {
    const w = c.weapons[type];
    return { damage: w.damage, speed: w.speed, life: w.life, cooldown: w.cooldown, spread: [...w.spread] };
  };
  // The fixed table includes codes for kits this content may not offer.
  const kit = (k: Kit) => c.kits[k] ?? { damage: 0, cooldown: 0 };
  return {
    movement: {
      // The old motor's speeds are per tick times HZ (`action_combat.rs`'s `motor`).
      motor: { baseSpeed: [MOVEMENT_SPEED.contestant * HZ, MOVEMENT_SPEED.gladiator * HZ],
        boost: [MOVEMENT_SPEED.contestantBoost, MOVEMENT_SPEED.gladiatorBoost], stun: MOVEMENT_SPEED.stun, sneak: MOVEMENT_SPEED.sneak,
        acceleration: a.acceleration, braking: a.braking },
      hook: { range: h.range, speed: h.speed, maxForce: h.maxForce, stiffness: h.stiffness, damping: h.damping, pullSpeed: h.pullSpeed,
        duration: h.durationTicks, cooldown: h.cooldownTicks, standoff: h.standoff, targetDistance: h.targetDistance, breakDistance: h.breakDistance },
      boostDuration: OVERDRIVE_TICKS,
      // Striker's Overdrive cools down by the kit's cooldown (`kit_cooldown[striker]`).
      boostCooldown: kit('striker').cooldown,
    },
    rules: {
      weapons: [weapon('pistol'), weapon('rifle'), weapon('scattergun')],
      meleeDamage: [kit('warden').damage, kit('specter').damage, kit('striker').damage, kit('hook').damage],
      wardenCooldown: kit('warden').cooldown,
      specterCooldown: kit('specter').cooldown,
      respawnTicks: c.gladiatorRespawnTicks,
      hearing: c.hearing ? { ranges: [c.hearing.ranges.pistol ?? 0, c.hearing.ranges.rifle ?? 0, c.hearing.ranges.scattergun ?? 0],
        ticks: c.hearing.ticks, width: s.map.width, height: s.map.height } : null,
    },
    items: { reloading: c.reloading !== undefined, qualityDamage: c.lootTiers !== undefined,
      drops: { groundCapacity: c.itemInstances.groundCapacity, optionalBodyCapacity: DYNAMIC_BODY_CAPACITY, bodyCapacity: DYNAMIC_BODY_CAPACITY,
        dropReserve: c.worldPhysics.dropReserve ?? 0 } },
    interactions: { chargeTicks: c.cellChargeTicks, transitBase: c.transitTime?.base ?? 0, transitPerUnit: c.transitTime?.perUnit ?? 0 },
    hazards: {
      mine: { trigger: t.mine.trigger, blast: t.mine.blast, damage: t.mine.damage, worldImpulse: c.worldPhysics.maxImpulse, actorImpulseLimit: a.maxImpulse },
      turret: { ...t.turret },
      flame: { ...t.flame },
      spider: { ...t.spider },
    },
  };
}

/**
 * A spec as the setup carries it. `templateRow` validates the spec and derives its row (shape dimensions, collision
 * groups, loot flag) as the old world admits it; this is the one place that reads that row's layout (`world.rs`
 * `pending_from`: the key, 21 words, then the vertices), and an unset damping, NaN there, becomes null.
 */
function setupBody(spec: BodySpec): SetupBody {
  const row = templateRow(spec), v = (i: number) => row[i]!, unset = (x: number) => Number.isNaN(x) ? null : x;
  return { kind: v(1), mapGeometry: v(2) !== 0, shape: v(3), a: v(4), b: v(5), pose: [v(6), v(7), v(8), v(9), v(10), v(11)],
    material: [v(12), v(13), v(14)], damping: [unset(v(15)), unset(v(16))], groups: v(17), loot: v(18) !== 0,
    speedLimit: v(19), tipRadius: v(20), vertices: Array.from(row.subarray(22, 22 + 2 * v(21))) };
}

/**
 * Map a freshly created game into the new tick's setup and the ID maps that go with it. Throws a `RangeError` for a game
 * the setup cannot hold: one not at its start, or holding a projectile, hook, charge, transit, reload in progress, or
 * pending spawns or impulses.
 */
export function matchSetup(s: Game): { setup: MatchSetup; ids: MatchIds } {
  const runtime = physicsRuntime(s);
  if (!runtime) refuse('the game has no physics world (use createGame)');
  if (s.phase !== 'live') refuse(`the game's phase is ${s.phase}`);
  if (s.tick !== 0) refuse(`the game is at tick ${s.tick}, not its start`);
  if (s.projectiles.length) refuse('a projectile is in flight');
  if (runtime.hooks.length) refuse('a hook is in flight');
  if (runtime.pendingSpawns.length || runtime.pendingImpulses.length || runtime.pendingAttachments.length) refuse('spawns, impulses or attachments are pending');
  checkBaked(s);

  const tick = s.tick;
  // --- Identities --------------------------------------------------------
  const actorOfPlayer = new Map<PlayerId, number>(), playerOfActor = new Map<number, PlayerId>();
  const actorAtSlot: number[] = [], slotOfActor = new Map<number, PlayerIdx>();
  let contestants = 0, gladiators = 0;
  for (const p of s.players) {
    const kind = p.role, seat = kind === 'contestant' ? p.seat ?? contestants : gladiators;
    if (kind === 'contestant') contestants++; else gladiators++;
    if (!Number.isSafeInteger(seat) || seat < 0) refuse(`${p.id} has an invalid seat ${seat}`);
    const word = actorWord(kind, seat);
    if (actorOfPlayer.has(p.id)) refuse(`duplicate roster label ${p.id}`);
    if (playerOfActor.has(word)) refuse(`${p.id} shares its seat with ${playerOfActor.get(word)}`);
    slotOfActor.set(word, actorAtSlot.length as PlayerIdx);
    actorAtSlot.push(word);
    actorOfPlayer.set(p.id, word); playerOfActor.set(word, p.id);
  }
  const bindPlayer = (slot: PlayerIdx, id: PlayerId) => {
    const word = actorAtSlot[slot]!;
    actorOfPlayer.delete(playerOfActor.get(word)!);
    actorOfPlayer.set(id, word);
    playerOfActor.set(word, id);
  };
  const buildingIds = [...new Set([...s.map.buildings.map(b => b.id), ...s.gates.map(g => g.buildingId), ...s.items.map(i => i.buildingId)].filter(id => id !== undefined))].sort(compare);
  const buildingIndex = new Map(buildingIds.map((id, i) => [id, i] as const));
  const gateIds = s.gates.map(g => g.id), gateIndex = new Map(gateIds.map((id, i) => [id, i] as const));
  const trapIds = s.traps.map(t => t.id), trapIndex = new Map(trapIds.map((id, i) => [id, i] as const));
  const stationList: MatchIds['stations'][number][] = [
    ...s.map.chargers.map(c => ({ kind: 'charging' as const, id: c.id })), ...s.map.stations.map(t => ({ kind: 'transit' as const, id: t.id }))];
  const chargerIndex = new Map(s.map.chargers.map((c, i) => [c.id, i] as const));
  const transitIndex = new Map(s.map.stations.map((t, i) => [t.id, s.map.chargers.length + i] as const));
  const props = authoredProps(s);
  const propNumber = new Map(props.map((p, i) => [p.label, i] as const));
  // The geometry is numbered as `createGame` queued it: built, then sorted by ID.
  const geometry = buildPhysicsGeometry(s.map).sort((a, b) => compare(a.id, b.id));
  const geometryNumber = new Map(geometry.map((g, i) => [g.id, i] as const));

  // --- Actors ------------------------------------------------------------
  const t = templatesOf(s);
  const bodies: BodyRow[] = [];
  const actors: ActorEntry[] = s.players.map(p => {
    if (p.reload) refuse(`${p.id} has a reload in progress`);
    if (p.charging) refuse(`${p.id} is charging`);
    if (p.transit || p.status === 'transit') refuse(`${p.id} is in transit`);
    const word = actorOfPlayer.get(p.id)!;
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => {
      const item = p.inventory?.[i];
      if (!item) return null;
      if (item.instanceId === undefined) refuse(`${p.id}'s slot ${i} holds an unidentified item`);
      return { id: item.instanceId, lineage: item.lineageId ?? item.instanceId, equipment: equipmentOf(s, item) };
    });
    const statuses: Actor['statuses'] = {};
    for (const [key, value] of [['boost', p.boost], ['cloak', p.cloak], ['reveal', p.revealed], ['stun', p.stun]] as const) {
      const w = windowOf(tick, value);
      if (w) statuses[key] = w;
    }
    const source = p.aggressor === undefined ? undefined : actorOfPlayer.get(p.aggressor);
    const actor: Actor = {
      presence: PRESENCE[p.status], kit: kitOf(p), level: p.level, kills: p.kills,
      hp: p.hp, maxHp: p.maxHp, shield: p.shield, maxShield: UTILITY_RULES.maxShield,
      aim: p.heading, sneak: p.input.sneak ?? false, viewLag: p.viewLagTicks ?? 0,
      inventory: { slots, selected: p.selectedSlot ?? 0, reserves: [p.reserves?.pistol ?? 0, p.reserves?.rifle ?? 0, p.reserves?.shell ?? 0], keys: p.keys, reload: null },
      charging: null, respawnAt: p.respawnAt ?? null, transit: null, bot: p.bot,
      aggression: source !== undefined && p.aggressionUntil !== undefined ? { source, expiresAt: p.aggressionUntil } : null,
      deadlines: { skillReadyAt: deadline(tick, p.cooldown), weaponReadyAt: deadline(tick, p.attackCd), transitReadyAt: deadline(tick, p.railCd) },
      statuses,
    };
    // Every actor's spec: the core gives only active ones a body now, and admits the rest from it on a respawn or arrival.
    bodies.push({ id: { kind: 'actor', id: word }, body: setupBody({ ...t.actor[p.role], x: p.x, y: p.y }) });
    return { kind: p.role, seat: word % 2 ** 32, word, actor };
  }).sort((a, b) => a.word - b.word);

  // --- Ground ------------------------------------------------------------
  // Every item starts unplaced, with no body row: the new tick admits them through its own placement at T1.
  const items: GroundEntry[] = [];
  let top = 0;
  for (const item of s.items) {
    const id = item.id as number, lineage = item.lineageId as number | undefined;
    top = Math.max(top, id, lineage ?? 0);
    const dropper = item.droppedBy === undefined ? undefined : actorOfPlayer.get(item.droppedBy);
    if (item.droppedBy !== undefined && dropper === undefined) refuse(`ground item ${id} was dropped by an unknown player`);
    const row: GroundEntry['item'] = { loot: lootOf(s, item), lineage: lineage !== undefined && lineage !== id ? lineage : null,
      unplacedAt: pointOf(item), droppedBy: dropper ?? null, pickupReadyAt: item.pickupAfter ?? 0 };
    Object.defineProperty(row, 'building', { value: item.buildingId === undefined ? null : buildingIndex.get(item.buildingId)!, enumerable: false });
    items.push({ id, item: row });
  }
  items.sort((a, b) => a.id - b.id);
  for (const a of actors) for (const slot of a.actor.inventory.slots) if (slot) top = Math.max(top, slot.id, slot.lineage);
  // The new tick numbers new items from the largest ID it holds (`Ids::from_state`).
  if (s.itemSerial !== undefined && s.itemSerial !== top + 1) refuse(`the next item ID ${s.itemSerial} is not one past the largest held, ${top}`);

  // --- Props, gates, geometry --------------------------------------------
  props.forEach(({ spec }, i) => bodies.push({ id: { kind: 'prop', id: i }, body: setupBody(spec) }));
  // A gate's body is its closed shape, as `uploadGateBodies` builds it; the new tick removes an open gate's.
  s.gates.forEach((gate, i) => bodies.push({ id: { kind: 'gate', id: i }, body: setupBody(physicsGate({ ...gate, open: false })) }));
  geometry.forEach((g, i) => bodies.push({ id: { kind: 'geometry', id: i }, body: setupBody({ ...g, mapGeometry: true }) }));

  // --- Records -----------------------------------------------------------
  const gates: GateEntry[] = s.gates.map((g, id) => {
    const gate: GateEntry['gate'] = { open: g.open, locked: g.locked ?? g.kind !== 'door', door: g.kind === 'door', position: pointOf(g) };
    Object.defineProperty(gate, 'building', { value: g.buildingId === undefined ? null : buildingIndex.get(g.buildingId)!, enumerable: false });
    return { id, gate };
  });
  const traps: TrapEntry[] = s.traps.map((trap, id) => {
    const target = trap.targetId == null ? undefined : actorOfPlayer.get(trap.targetId);
    const kind: TrapKind = trap.kind === 'mine' ? { kind: 'mine', spent: trap.spent }
      : trap.kind === 'turret' ? { kind: 'turret', aiming: trap.aiming ?? false }
        : trap.kind === 'flame' ? { kind: 'flame', offset: trap.offset, warning: trap.warning ?? false, firing: trap.firing ?? false }
          : { kind: 'spider', home: [trap.homeX, trap.homeY], target: target ?? null };
    return { id, trap: { position: pointOf(trap), heading: trap.heading, readyAt: deadline(tick, trap.cooldown), kind } };
  });
  const stations: StationEntry[] = [
    ...s.map.chargers.map(c => ({ kind: 'charging' as const, position: pointOf(c) })),
    ...s.map.stations.map(st => ({ kind: 'transit' as const, position: pointOf(st) }))].map((station, id) => ({ id, station }));

  const state: State = { actors, items, projectiles: [], hooks: [], gates, traps, stations,
    extraction: { position: pointOf(s.map.exit), slots: s.slots }, sensors: s.map.sensors.map(pointOf), hazardX: s.hazardX };

  // --- Floors ------------------------------------------------------------
  const ranked = [...s.map.motorSurfaces ?? []].sort((a, b) => compare(a.id, b.id));
  const rank = new Map(ranked.map((f, i) => [f, i] as const));
  const motorSurfaces: MotorSurface[] = [...s.map.motorSurfaces ?? []].sort((a, b) => b.priority - a.priority || compare(a.id, b.id))
    .map(f => ({ idRank: rank.get(f)!, priority: f.priority, origin: [f.x, f.y], size: [f.w, f.h],
      speed: f.speed ?? 1, traction: f.traction ?? 1, braking: f.braking ?? 1, drag: f.drag ?? null }));
  const { loot, prop } = s.content.worldPhysics;

  return {
    setup: { seed: s.seed, timeLimit: s.content.durationTicks, state, bodies, motorSurfaces,
      floorBases: { loot: [loot.linearDamping, loot.angularDamping], prop: [prop.linearDamping, prop.angularDamping] },
      hazardAreas: s.map.hazards.map(h => [h.x, h.y, h.w, h.h]),
      hazardWall: { mapWidth: s.map.width, graceTicks: s.content.hazardGraceTicks },
      // Actors and spots lie inside the map's box (the old collision test's first condition).
      bounds: [0, 0, s.map.width, s.map.height],
      entryX: s.map.entry?.x ?? 0,
      bots: { hearing: s.content.hearingResponse === 'temperament',
        hunting: s.content.hunting === 'front' ? 2 : s.content.hunting === 'sweep' ? 1 : 0,
        portals: s.content.hunterPlanning === 'portals', selectableTransit: s.content.transit === 'selectable',
        roster: s.players.map(p => ({ actor: actorOfPlayer.get(p.id)!,
          ...botLabel(playerOfActor.values(), p.id), inventory: p.inventory !== undefined })) },
      tuning: tuningOf(s) },
    ids: { actorAtSlot, slotOfActor, actorOfPlayer, playerOfActor, bindPlayer, buildingIds, gateIndex, gateIds, trapIndex, trapIds, chargerIndex, transitIndex, stations: stationList,
      propNumber, propLabels: props.map(p => p.label), geometryNumber, geometryIds: geometry.map(g => g.id) },
  };
}

// ---------------------------------------------------------------------------
// The live match
// ---------------------------------------------------------------------------

/** The core's `match_*` exports (`rust/core/src/lib.rs`). */
interface MatchExports {
  match_new(setup: number, setupLength: number, swept: number, sightIndex: number, gateSet: number,
    discoveryMap: number, discoveryIndex: number, discoveryGates: number, collision: number, roofs: number): number;
  match_free(game: number): void;
  match_set_navigation(game: number, navigation: number): number;
  match_input(game: number, words: number): number;
  match_submit(game: number, tick: number, count: number): number;
  match_submit_flags(game: number): number;
  match_step(game: number): number;
  match_output_len(game: number): number;
  match_snapshot(game: number): number;
  match_memory(game: number, actor: number): number;
  match_bot_route(game: number, actor: number): number;
  match_bot_routes(game: number): number;
  match_heard(game: number, actor: number): number;
  match_acknowledged(game: number, actor: number): number;
}
type MatchCore = CoreExports & MatchExports;

const live = new FinalizationRegistry<{ core: MatchCore; pointer: number }>(({ core, pointer }) => core.match_free(pointer));

/**
 * A new-tick match started from a game's setup (27.2 "Live adapter (3d.1)"). Every call makes its views after the call, since a
 * call may grow WASM memory, and decodes the output into objects before the next, so nothing borrowed outlives a call.
 */
export class TickMatch {
  readonly setup: MatchSetup;
  readonly ids: MatchIds;
  readonly #core: MatchCore;
  #pointer: number;

  /** Packs `setup` (from `matchSetup(s)`, which the caller may adjust first) and starts the match. Throws when the core refuses it. */
  constructor(s: Game, setup: MatchSetup, ids: MatchIds, navigation?: number) {
    const sight = sightOf(s), map = s.map;
    // The map's handles first: building one may grow the memory, and the core copies them.
    const { core, collision, index, gates } = sight.queryHandles(map);
    const swept = sight.sweptHandle(map);
    const roofs = sight.discoveryHandle(map, discoveryTables);
    const discovery = s.content.discovery ? roofs : 0;
    const matchCore = core as MatchCore;
    const words = encodeSetup(setup), bytes = words.length * 8, buffer = matchCore.core_alloc(bytes) >>> 0;
    let pointer: number;
    try {
      new Float64Array(matchCore.memory.buffer, buffer, words.length).set(words);
      pointer = matchCore.match_new(buffer, words.length, swept, index, gates, discovery, discovery ? index : 0, discovery ? gates : 0, collision, roofs) >>> 0;
    } finally { matchCore.core_free(buffer, bytes); }
    if (pointer === 0) throw new Error('tick-match: the core refused the match setup');
    try {
      const local = navigation === undefined ? createRuntimeNavigation(core, map) : undefined;
      try {
        const candidate = navigation ?? local?.pointer;
        if (candidate && !matchCore.match_set_navigation(pointer, candidate))
          throw new Error('tick-match: the core refused the navigation package');
      } finally { local?.release(); }
    } catch (error) {
      matchCore.match_free(pointer);
      throw error;
    }
    this.setup = setup; this.ids = ids; this.#core = matchCore; this.#pointer = pointer;
    live.register(this, { core: matchCore, pointer }, this);
  }

  #live(): number {
    if (this.#pointer === 0) throw new Error('tick-match: the match is disposed');
    return this.#pointer;
  }
  /** The words of the last call's output at `pointer`, decoded by `read`. */
  #read<T>(pointer: number, read: (words: Float64Array) => T): T {
    const core = this.#core, length = core.match_output_len(this.#pointer);
    return read(new Float64Array(core.memory.buffer, pointer >>> 0, length));
  }

  /** Queue inbound rows for `tick`; one flag per row, true when the match queued it. */
  submit(tick: Tick, rows: readonly Inbound[]): boolean[] {
    const game = this.#live(), core = this.#core;
    if (!rows.length) return [];
    const words = encodeInbound(rows);
    const input = core.match_input(game, words.length) >>> 0;
    new Float64Array(core.memory.buffer, input, words.length).set(words);
    core.match_submit(game, tick, rows.length);
    const flags = core.match_submit_flags(game) >>> 0;
    const queued = Array.from(new Uint8Array(core.memory.buffer, flags, rows.length), flag => flag === 1);
    const accepted = rows.filter((_, i) => queued[i]);
    if (accepted.length) for (const take of this.#submitted) take(tick, accepted);
    return queued;
  }
  readonly #followers: ((completed: DecodedTick) => void)[] = [];
  readonly #submitted: ((tick: Tick, rows: readonly Inbound[]) => void)[] = [];
  /**
   * Hand every completed tick to `take` as the step decodes it, before the step returns, and, given `submitted`, the rows
   * the match queued for a tick as they are submitted (the frames, `tick-frame.ts`).
   */
  follow(take: (completed: DecodedTick) => void, submitted?: (tick: Tick, rows: readonly Inbound[]) => void): void {
    this.#followers.push(take);
    if (submitted) this.#submitted.push(submitted);
  }
  /** Step one tick, or null once the match is over. */
  step(): DecodedTick | null {
    const pointer = this.#core.match_step(this.#live()) >>> 0;
    if (pointer === 0) return null;
    const completed = this.#read(pointer, decodeCompleted);
    for (const take of this.#followers) take(completed);
    return completed;
  }
  snapshot(): Snapshot { return this.#read(this.#core.match_snapshot(this.#live()), decodeSnapshot); }
  #actor(id: PlayerId): number {
    const word = this.ids.actorOfPlayer.get(id);
    if (word === undefined) throw new RangeError(`tick-match: no player ${id}`);
    return word;
  }
  /** A contestant's discovery memory as of the last completed tick; null for none. */
  memory(id: PlayerId): Memory | null { return this.#read(this.#core.match_memory(this.#live(), this.#actor(id)), decodeMemory); }
  /** The remaining route in the core planner, projected on demand for diagnostics. */
  botRoute(id: PlayerId): { x: number; y: number }[] {
    return this.#read(this.#core.match_bot_route(this.#live(), this.#actor(id)), words =>
      Array.from({ length: words.length / 2 }, (_, i) => ({ x: words[i * 2]!, y: words[i * 2 + 1]! })));
  }
  /** Routes for the private snapshot. An empty plan is distinct from an actor with no plan. */
  botRoutes() { return this.#read(this.#core.match_bot_routes(this.#live()), decodeBotRoutes); }
  /** The cues a player hears as of the last completed tick, oldest first. */
  heard(id: PlayerId): Cue[] { return this.#read(this.#core.match_heard(this.#live(), this.#actor(id)), decodeCues); }
  /** The last command sequence spent for the player, or null. */
  acknowledged(id: PlayerId): number | null {
    const seq = this.#core.match_acknowledged(this.#live(), this.#actor(id));
    return seq < 0 ? null : seq;
  }
  dispose(): void {
    if (this.#pointer === 0) return;
    live.unregister(this);
    this.#core.match_free(this.#pointer);
    this.#pointer = 0;
  }
}

/** Map the game and start its match. */
export function createTickMatch(s: Game, navigation?: number): TickMatch {
  const { setup, ids } = matchSetup(s);
  return new TickMatch(s, setup, ids, navigation);
}
