import type { AmmoFamily, Kit, WeaponType } from '../types.ts';

// The TypeScript mirror of `rust/core/src/tick/codec.rs`, which owns the word layout (27.2 "Live adapter (3d.1)"). Every
// constant here has the Rust name and value, and every row is written and read in the order its module documentation gives.
// The records are the new tick's (`rust/core/src/tick/state.rs`) as plain typed objects; a Rust enum is a discriminated
// union. Tables are arrays of entries in ascending ID order, which is a `BTreeMap`'s iteration order.

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

export type Point = readonly [number, number];
export type Tick = number;

export type Presence = 'pending' | 'active' | 'eliminated' | 'escaped' | 'transit' | 'stranded';
export type Status = 'boost' | 'cloak' | 'reveal' | 'stun';
/** A status is effective in the half-open interval [activeFrom, expiresAt) (`Window::contains`). */
export interface Window { activeFrom: Tick; expiresAt: Tick }
export interface Deadlines { skillReadyAt: Tick; weaponReadyAt: Tick; transitReadyAt: Tick }
export type WeaponKind = WeaponType;
export type Utility = 'medkit' | 'shield';

export type EquipmentKind =
  | { kind: 'firearm'; weapon: WeaponKind; rounds: number }
  | { kind: 'stack'; utility: Utility; count: number }
  | { kind: 'cell'; charge: number };
export interface Equipment { kind: EquipmentKind; quality: number }
export interface CarriedItem { id: number; lineage: number; equipment: Equipment }
export type Loot =
  | { kind: 'accessKey' }
  | { kind: 'equipment'; equipment: Equipment }
  | { kind: 'ammo'; family: AmmoFamily; count: number };
export interface Reload { slot: number; item: number; readyAt: Tick }
export interface Inventory {
  /** Six slots. */
  slots: (CarriedItem | null)[];
  selected: number;
  /** Pistol, rifle, shell. */
  reserves: [number, number, number];
  keys: number;
  reload: Reload | null;
}

export interface Charging { station: number; cell: number }
export interface Transit { destination: number; origin: Point; arriveAt: Tick }
/** Another actor, by actor word. */
export interface Aggression { source: number; expiresAt: Tick }

export interface Actor {
  presence: Presence;
  /** Null for a contestant, whose kit is inert (see `tick-match.ts`). */
  kit: Kit | null;
  level: number;
  kills: number;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  aim: number;
  sneak: boolean;
  viewLag: Tick;
  inventory: Inventory;
  charging: Charging | null;
  respawnAt: Tick | null;
  transit: Transit | null;
  bot: boolean;
  aggression: Aggression | null;
  deadlines: Deadlines;
  /** Only the statuses that have a window. */
  statuses: Partial<Record<Status, Window>>;
}
/** An actor and its identity: `word` is `actor_word` (`(kind << 32) | seat`), a plain number below 2^53. */
export interface ActorEntry { kind: 'contestant' | 'gladiator'; seat: number; word: number; actor: Actor }

export interface GroundItem {
  building?: number | null;
  loot: Loot;
  /** Null when the item's own ID is the root. */
  lineage: number | null;
  /** The fallback position while no body has been admitted yet. */
  unplacedAt: Point | null;
  /** The dropper's actor word. */
  droppedBy: number | null;
  pickupReadyAt: Tick;
}
export interface GroundEntry { id: number; item: GroundItem }

export type EntityKind = 'actor' | 'item' | 'projectile' | 'hook' | 'gate' | 'trap' | 'station' | 'prop' | 'geometry' | 'match';
/** An entity: `id` is the actor word for an actor and 0 for the match. */
export interface Entity { kind: EntityKind; id: number }
export type BodyKind = 'actor' | 'item' | 'prop' | 'gate' | 'geometry';
export interface BodyRef extends Entity { kind: BodyKind }

export interface Projectile { source: Entity; position: Point; velocity: Point; damage: number; activeFrom: Tick; expiresAt: Tick }
export interface ProjectileEntry { id: number; projectile: Projectile }
export type HookPhase =
  | { kind: 'flying'; position: Point; direction: Point; travelled: number }
  | { kind: 'pulling'; target: number; length: number };
export interface Hook { owner: number; phase: HookPhase; expiresAt: Tick }
export interface HookEntry { id: number; hook: Hook }

export interface Gate { building?: number | null; open: boolean; locked: boolean; door: boolean; position: Point }
export interface GateEntry { id: number; gate: Gate }

export type TrapKind =
  | { kind: 'mine'; spent: boolean }
  | { kind: 'turret'; aiming: boolean }
  | { kind: 'flame'; offset: Tick; warning: boolean; firing: boolean }
  | { kind: 'spider'; home: Point; target: number | null };
export interface Trap { position: Point; heading: number; readyAt: Tick; kind: TrapKind }
export interface TrapEntry { id: number; trap: Trap }

export interface Station { kind: 'charging' | 'transit'; position: Point }
export interface StationEntry { id: number; station: Station }
export interface Extraction { position: Point; slots: number }

export interface State {
  actors: ActorEntry[];
  items: GroundEntry[];
  projectiles: ProjectileEntry[];
  hooks: HookEntry[];
  gates: GateEntry[];
  traps: TrapEntry[];
  stations: StationEntry[];
  extraction: Extraction | null;
  sensors: Point[];
  /** The advancing wall's x, or null for a match without a wall. */
  hazardX: number | null;
}

/** A dynamic body's committed pose (`tick::Pose`): position, rotation, motion and whether Rapier put it to sleep. */
export interface PoseEntry { body: BodyRef; at: Point; angle: number; velocity: Point; spin: number; sleeping: boolean }
export interface Snapshot { tick: Tick; state: State; poses: PoseEntry[] }

// --- Inbound ----------------------------------------------------------------

/** `unresolved` is a nomination the receive boundary could not map (27.2 R8): the core rejects it, pressed, and tries nothing else. */
export type Target = { kind: 'extraction' } | { kind: 'station'; id: number } | { kind: 'gate'; id: number } | { kind: 'item'; id: number }
  | { kind: 'unresolved' };
export type DropSlot = { kind: 'selected' } | { kind: 'slot'; slot: number };
export interface Input {
  movement: Point;
  aim: number | null;
  sneak: boolean;
  attack: boolean;
  utilitySlot: number | null;
  skill: boolean;
  interact: boolean;
  target: Target | null;
  slot: number | null;
  moveSlot: readonly [number, number] | null;
  drop: DropSlot | null;
  reload: boolean;
  dropAmmo: { family: AmmoFamily; count: number } | null;
  transit: number | null;
}
export type CommandSource = 'player' | 'bot';
export interface Command { actor: number; source: CommandSource; tick: Tick; seq: number; input: Input }
export type Observation =
  | { kind: 'viewLag'; actor: number; ticks: Tick }
  | { kind: 'inputLead'; actor: number; ticks: Tick }
  | { kind: 'join'; actor: number; kit?: Kit; botLabel?: BotLabel }
  | { kind: 'leave'; actor: number }
  | { kind: 'teleport'; body: BodyRef; to: Point };
export type Carried =
  | { kind: 'impulse'; body: BodyRef; impulse: Point }
  | { kind: 'killReward'; actor: number }
  | { kind: 'gateObserved'; actor: number; gate: number; open: boolean; locked: boolean };
export interface BotLabel { rank: number; opportunistic: boolean }
export type Inbound =
  | { type: 'command'; command: Command }
  | { type: 'observation'; observation: Observation }
  | { type: 'carried'; carried: Carried };

/** An input with nothing pressed. */
export const emptyInput = (): Input => ({ movement: [0, 0], aim: null, sneak: false, attack: false, utilitySlot: null, skill: false,
  interact: false, target: null, slot: null, moveSlot: null, drop: null, reload: false, dropAmmo: null, transit: null });

// --- Events -----------------------------------------------------------------

export type HookRelease = 'cancelled' | 'expired' | 'obstructed' | 'friendlyContact' | 'range' | 'standoff' | 'separation' | 'endpointGone' | 'relocated';
export type Rejection =
  | { kind: 'skillCooldown' } | { kind: 'hookCapacity' } | { kind: 'drop' } | { kind: 'dropAmmo'; family: AmmoFamily }
  | { kind: 'reload' } | { kind: 'selectSlot' } | { kind: 'moveSlot' }
  | { kind: 'pickup'; item: number } | { kind: 'swap'; item: number }
  | { kind: 'interaction'; target: Target | null }
  | { kind: 'gateLocked'; gate: number } | { kind: 'gateOccupied'; gate: number } | { kind: 'gateContested'; gate: number }
  | { kind: 'transit'; station: number };
export type Fact =
  | { kind: 'hit'; source: Entity; target: number }
  | { kind: 'rejected'; actor: number; reason: Rejection }
  | { kind: 'eliminated'; actor: number }
  | { kind: 'respawned'; actor: number }
  | { kind: 'killCredited'; actor: number; target: number }
  | { kind: 'assisted'; actor: number; target: number }
  | { kind: 'killRewarded'; actor: number }
  | { kind: 'placed'; source: Entity; placed: Entity }
  | { kind: 'boosted'; actor: number }
  | { kind: 'shotFired'; actor: number; weapon: WeaponKind }
  | { kind: 'reloadStarted'; actor: number; readyAt: Tick }
  | { kind: 'reloaded'; actor: number; weapon: WeaponKind; rounds: number }
  | { kind: 'pickup'; actor: number; item: number; count: number }
  /** `slots` is what remains after this escape's slot. */
  | { kind: 'escaped'; actor: number; cell: number; slots: number }
  | { kind: 'chargingStarted'; actor: number; station: number }
  | { kind: 'chargingStopped'; actor: number; station: number }
  | { kind: 'cellCharged'; actor: number; station: number }
  | { kind: 'gateChanged'; actor: number; gate: number; open: boolean }
  | { kind: 'gateObserved'; actor: number; gate: number; open: boolean; locked: boolean }
  | { kind: 'transitDeparted'; actor: number; station: number }
  | { kind: 'transitLanded'; actor: number; station: number }
  | { kind: 'utilityUsed'; actor: number; utility: Utility }
  | { kind: 'meleeSwung'; actor: number }
  | { kind: 'wardenPulsed'; actor: number }
  | { kind: 'specterScanned'; actor: number }
  | { kind: 'hookFired'; owner: number }
  | { kind: 'hookAttached'; owner: number; target: number }
  | { kind: 'hookReleased'; owner: number; reason: HookRelease }
  | { kind: 'mineExploded'; trap: number }
  | { kind: 'spiderGrappled'; trap: number; target: number; at: Point }
  | { kind: 'heard'; listener: number; at: Point; until: Tick }
  | { kind: 'contact'; substep: number; a: BodyRef; b: BodyRef; contact: 'started' | 'stopped' }
  | { kind: 'finished' };
export interface GameEvent { id: number; tick: Tick; fact: Fact }

export interface Changes {
  actors: ActorEntry[];
  items: GroundEntry[];
  projectiles: ProjectileEntry[];
  hooks: HookEntry[];
  gates: GateEntry[];
  traps: TrapEntry[];
  /** Present when the remaining slots changed. */
  extraction: Extraction | null;
  /** Present when the wall moved. */
  hazardX: number | null;
  removed: Entity[];
  poses: PoseEntry[];
  events: GameEvent[];
}

export type Discontinuity = { kind: 'placed' | 'warped' | 'removed'; body: BodyRef } | { kind: 'devWarped'; body: BodyRef; request: number };
export interface GateObservation { actor: number; gate: number; open: boolean; locked: boolean }
export interface DiscoverySample { actor: number; eye: Point }
export interface Discovery { gates: GateObservation[]; samples: DiscoverySample[] }
export interface DecodedTick {
  tick: Tick; inbound: Inbound[]; changes: Changes; discontinuities: Discontinuity[]; discovery: Discovery;
  readonly botRoutes?: { actor: number; route: { x: number; y: number }[] }[];
}

export interface RememberedItem { id: number; at: Point; item: GroundItem }
export interface DoorMemory { gate: number; open: boolean; locked: boolean }
export interface Memory { discovered: number[]; seen: number[]; surveyed: number[]; items: RememberedItem[]; gates: DoorMemory[]; revision: number }
export interface Cue { at: Point; tick: Tick; until: Tick }

// --- The setup ----------------------------------------------------------------

/** A body's spec as the setup carries it: `BodySpec` (`rust/core/src/tick/solve.rs`) and its `BodyParams`. */
export interface SetupBody {
  kind: number;
  mapGeometry: boolean;
  shape: number;
  /** The shape's two dimensions: a circle's radius, or a box's half extents. */
  a: number;
  b: number;
  /** `x, y, angle, vx, vy, omega`. */
  pose: [number, number, number, number, number, number];
  /** Mass, friction, restitution. */
  material: [number, number, number];
  /** `[linear, angular]`; null leaves the engine's default. */
  damping: [number | null, number | null];
  groups: number;
  loot: boolean;
  speedLimit: number;
  tipRadius: number;
  /** A convex outline's `x, y` pairs, empty for other shapes. */
  vertices: number[];
}
export interface BodyRow { id: BodyRef; body: SetupBody }

/** `MotorSurface`, with `id` replaced by its rank among all surfaces' IDs in UTF-16 code-unit order. */
export interface MotorSurface {
  idRank: number;
  priority: number;
  origin: Point;
  size: Point;
  speed: number;
  traction: number;
  braking: number;
  drag: number | null;
}

export interface WeaponTuning { damage: number; speed: number; life: Tick; cooldown: Tick; spread: number[] }
export interface HookTuning {
  range: number; speed: number; maxForce: number; stiffness: number; damping: number; pullSpeed: number;
  duration: Tick; cooldown: Tick; standoff: number; targetDistance: number; breakDistance: number;
}
export interface Tuning {
  movement: {
    motor: { baseSpeed: [number, number]; boost: [number, number]; stun: number; sneak: number; acceleration: number; braking: number };
    hook: HookTuning;
    boostDuration: Tick;
    boostCooldown: Tick;
  };
  rules: {
    /** Pistol, rifle, scattergun. */
    weapons: [WeaponTuning, WeaponTuning, WeaponTuning];
    /** Warden, Specter, Striker, Hook. */
    meleeDamage: [number, number, number, number];
    wardenCooldown: Tick;
    specterCooldown: Tick;
    respawnTicks: Tick;
    hearing: { ranges: [number, number, number]; ticks: Tick; width: number; height: number } | null;
  };
  items: { reloading: boolean; qualityDamage: boolean;
    drops: { groundCapacity: number; optionalBodyCapacity: number; bodyCapacity: number; dropReserve: number } };
  interactions: { chargeTicks: Tick; transitBase: number; transitPerUnit: number };
  hazards: {
    mine: { trigger: number; blast: number; damage: number; worldImpulse: number; actorImpulseLimit: number };
    turret: { range: number; cooldown: Tick; speed: number; damage: number; life: Tick };
    flame: { cycle: Tick; warnAt: Tick; fireAt: Tick; interval: Tick; range: number; cone: number; damage: number };
    spider: { leash: number; acquire: number; step: number; grapple: number; cooldown: Tick; stun: Tick; damage: number };
  };
}

export interface MatchSetup {
  seed: number;
  timeLimit: Tick;
  state: State;
  bodies: BodyRow[];
  /** In `Movement`'s order: priority descending, then ID order. */
  motorSurfaces: MotorSurface[];
  /** `Movement::floor_drag`'s bases: linear then angular damping. */
  floorBases: { loot: Point; prop: Point };
  hazardAreas: [number, number, number, number][];
  /** The wall's map width and grace; its duration is `timeLimit`. */
  hazardWall: { mapWidth: number; graceTicks: Tick } | null;
  /** The world box actors and spots must lie in: `min x, min y, max x, max y`. */
  bounds: [number, number, number, number] | null;
  entryX?: number;
  bots?: { hearing: boolean; hunting: number; portals: boolean; selectableTransit: boolean;
    roster: readonly (BotLabel & { actor: number; inventory: boolean })[] };
  tuning: Tuning;
}

// ---------------------------------------------------------------------------
// Layout constants (`codec.rs`)
// ---------------------------------------------------------------------------

export const SLOT_COUNT = 6;
export const EQUIPMENT_WORDS = 4;
export const INVENTORY_WORDS = SLOT_COUNT * (3 + EQUIPMENT_WORDS) + 1 + 3 + 1 + 4;
export const LOOT_WORDS = 1 + EQUIPMENT_WORDS;
export const ACTOR_STRIDE = 93;
export const ITEM_STRIDE = 1 + LOOT_WORDS + 2 + 3 + 2 + 1 + 2;
export const PROJECTILE_STRIDE = 10;
export const HOOK_STRIDE = 9;
export const GATE_STRIDE = 8;
export const TRAP_STRIDE = 10;
export const STATION_STRIDE = 4;
export const EXTRACTION_WORDS = 4;
export const POSE_STRIDE = 9;
export const FACT_PAYLOAD = 6;
export const EVENT_STRIDE = 3 + FACT_PAYLOAD;
export const INPUT_WORDS = 27;
export const INBOUND_STRIDE = 1 + 4 + INPUT_WORDS;
export const DISCONTINUITY_STRIDE = 4;
export const GATE_OBSERVATION_STRIDE = 4;
export const SAMPLE_STRIDE = 3;
export const REMEMBERED_ITEM_STRIDE = 2 + ITEM_STRIDE;
export const DOOR_MEMORY_STRIDE = 3;
export const CUE_STRIDE = 4;
/** A body row's words before its vertices: the body (2) and `queue_add_body`'s row after its key. */
export const BODY_HEADER = 2 + 23;
export const SURFACE_ROW = 11;
export const MAX_SPREAD = 8;
const WEAPON_TUNING_WORDS = 5 + MAX_SPREAD;
export const TUNING_WORDS = 8 + 11 + 2 + 3 * WEAPON_TUNING_WORDS + 4 + 3 + 7 + 6 + 3 + 5 + 5 + 7 + 7;

const SAFE_INTEGER = 2 ** 53;
const PRESENCE: readonly Presence[] = ['pending', 'active', 'eliminated', 'escaped', 'transit', 'stranded'];
const KITS: readonly Kit[] = ['warden', 'specter', 'striker', 'hook'];
const WEAPONS: readonly WeaponKind[] = ['pistol', 'rifle', 'scattergun'];
const FAMILIES: readonly AmmoFamily[] = ['pistol', 'rifle', 'shell'];
const UTILITIES: readonly Utility[] = ['medkit', 'shield'];
const STATION_KINDS: readonly ('charging' | 'transit')[] = ['charging', 'transit'];
const SOURCES: readonly CommandSource[] = ['player', 'bot'];
const CONTACTS: readonly ('started' | 'stopped')[] = ['started', 'stopped'];
const STATUSES: readonly Status[] = ['boost', 'cloak', 'reveal', 'stun'];
const RELEASES: readonly HookRelease[] = ['cancelled', 'expired', 'obstructed', 'friendlyContact', 'range', 'standoff', 'separation', 'endpointGone', 'relocated'];
const ENTITIES: readonly EntityKind[] = ['actor', 'item', 'projectile', 'hook', 'gate', 'trap', 'station', 'prop', 'geometry', 'match'];
const BODY_KINDS: readonly BodyKind[] = ['actor', 'item', 'prop', 'gate', 'geometry'];
const TARGETS: readonly Target['kind'][] = ['extraction', 'station', 'gate', 'item', 'unresolved'];

/** `actor_word` (`tick/order.rs`): `(kind << 32) | seat`, as a plain number. */
export const actorWord = (kind: 'contestant' | 'gladiator', seat: number): number => (kind === 'contestant' ? 0 : 1) * 2 ** 32 + seat;
const actorOfWord = (word: number): { kind: 'contestant' | 'gladiator'; seat: number } | undefined => {
  const kind = Math.floor(word / 2 ** 32);
  return kind > 1 ? undefined : { kind: kind === 0 ? 'contestant' : 'gladiator', seat: word % 2 ** 32 };
};

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function bad(what: string): never { throw new RangeError(`tick-codec: ${what}`); }
const pickIndex = <T>(table: readonly T[], value: T, what: string): number => {
  const i = table.indexOf(value);
  return i < 0 ? bad(`unknown ${what} ${String(value)}`) : i;
};

/** Words as a plain array, then a `Float64Array`: every integer checked to be exact. */
export class Writer {
  readonly words: number[] = [];
  get length(): number { return this.words.length; }
  int(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > SAFE_INTEGER) bad(`${value} is not a word-exact unsigned integer`);
    this.words.push(value);
  }
  /** A count or index below 2^32 (a Rust `u32` reads back through a range check). */
  u32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 32) bad(`${value} does not fit a u32`);
    this.words.push(value);
  }
  /** Float words. Every word is finite: no NaN or infinity stands for a missing value (an option does). */
  raw(...values: number[]): void {
    for (const v of values) { if (!Number.isFinite(v)) bad(`${v} is not a finite word`); this.words.push(v); }
  }
  flag(value: boolean): void { this.words.push(value ? 1 : 0); }
  point(value: Point): void { this.raw(value[0], value[1]); }
  actor(word: number): void { if (!actorOfWord(word)) bad(`${word} is not an actor word`); this.int(word); }
  entity(value: Entity): void { this.u32(pickIndex(ENTITIES, value.kind, 'entity')); this.int(value.id); }
  body(value: BodyRef): void {
    pickIndex(BODY_KINDS, value.kind, 'body');
    this.entity(value);
  }
  pick<T>(table: readonly T[], value: T, what: string): void { this.u32(pickIndex(table, value, what)); }
  padTo(end: number): void {
    if (this.words.length > end) bad('a payload overran its row');
    while (this.words.length < end) this.words.push(0);
  }
  option<T>(width: number, value: T | null | undefined, write: (value: T) => void): void {
    const start = this.words.length;
    if (value === null || value === undefined) this.flag(false);
    else { this.flag(true); write(value); }
    this.padTo(start + 1 + width);
  }
}

function putEquipment(w: Writer, e: Equipment): void {
  const k = e.kind;
  if (k.kind === 'firearm') { w.u32(0); w.pick(WEAPONS, k.weapon, 'weapon'); w.u32(k.rounds); }
  else if (k.kind === 'stack') { w.u32(1); w.pick(UTILITIES, k.utility, 'utility'); w.u32(k.count); }
  else { w.u32(2); w.u32(k.charge); w.u32(0); }
  w.u32(e.quality);
}
function putLoot(w: Writer, loot: Loot): void {
  const start = w.length;
  if (loot.kind === 'accessKey') w.u32(0);
  else if (loot.kind === 'equipment') { w.u32(1); putEquipment(w, loot.equipment); }
  else { w.u32(2); w.pick(FAMILIES, loot.family, 'family'); w.u32(loot.count); }
  w.padTo(start + LOOT_WORDS);
}
function putInventory(w: Writer, inv: Inventory): void {
  const start = w.length;
  if (inv.slots.length !== SLOT_COUNT) bad(`an inventory has ${SLOT_COUNT} slots`);
  for (const slot of inv.slots) w.option(2 + EQUIPMENT_WORDS, slot, item => { w.u32(item.id); w.u32(item.lineage); putEquipment(w, item.equipment); });
  w.u32(inv.selected);
  for (const reserve of inv.reserves) w.u32(reserve);
  w.u32(inv.keys);
  w.option(3, inv.reload, r => { w.u32(r.slot); w.u32(r.item); w.u32(r.readyAt); });
  if (w.length - start !== INVENTORY_WORDS) bad('inventory width');
}
function putActor(w: Writer, entry: ActorEntry): void {
  const a = entry.actor, start = w.length;
  w.actor(entry.word);
  w.pick(PRESENCE, a.presence, 'presence');
  w.option(1, a.kit, kit => w.pick(KITS, kit, 'kit'));
  w.u32(a.level); w.u32(a.kills);
  w.raw(a.hp, a.maxHp, a.shield, a.maxShield, a.aim);
  w.flag(a.sneak); w.u32(a.viewLag);
  putInventory(w, a.inventory);
  w.option(2, a.charging, c => { w.u32(c.station); w.u32(c.cell); });
  w.option(1, a.respawnAt, at => w.u32(at));
  w.option(4, a.transit, t => { w.u32(t.destination); w.point(t.origin); w.u32(t.arriveAt); });
  w.flag(a.bot);
  w.option(2, a.aggression, g => { w.actor(g.source); w.u32(g.expiresAt); });
  w.u32(a.deadlines.skillReadyAt); w.u32(a.deadlines.weaponReadyAt); w.u32(a.deadlines.transitReadyAt);
  for (const status of STATUSES) w.option(2, a.statuses[status], win => { w.u32(win.activeFrom); w.u32(win.expiresAt); });
  if (w.length - start !== ACTOR_STRIDE) bad('actor width');
}
function putItem(w: Writer, id: number, item: GroundItem): void {
  const start = w.length;
  w.u32(id);
  putLoot(w, item.loot);
  w.option(1, item.lineage, l => w.u32(l));
  w.option(2, item.unplacedAt, at => w.point(at));
  w.option(1, item.droppedBy, d => w.actor(d));
  w.u32(item.pickupReadyAt);
  w.option(1, item.building ?? null, slot => w.u32(slot));
  if (w.length - start !== ITEM_STRIDE) bad('item width');
}
function putGate(w: Writer, e: GateEntry): void { w.u32(e.id); w.flag(e.gate.open); w.flag(e.gate.locked); w.flag(e.gate.door); w.point(e.gate.position); w.option(1, e.gate.building ?? null, slot => w.u32(slot)); }
function putTrap(w: Writer, e: TrapEntry): void {
  const t = e.trap;
  w.u32(e.id); w.point(t.position); w.raw(t.heading); w.u32(t.readyAt);
  const start = w.length, k = t.kind;
  if (k.kind === 'mine') { w.u32(0); w.flag(k.spent); }
  else if (k.kind === 'turret') { w.u32(1); w.flag(k.aiming); }
  else if (k.kind === 'flame') { w.u32(2); w.u32(k.offset); w.flag(k.warning); w.flag(k.firing); }
  else { w.u32(3); w.point(k.home); w.option(1, k.target, a => w.actor(a)); }
  w.padTo(start + 5);
}
function putStation(w: Writer, e: StationEntry): void { w.u32(e.id); w.pick(STATION_KINDS, e.station.kind, 'station kind'); w.point(e.station.position); }
function putProjectile(w: Writer, e: ProjectileEntry): void {
  const p = e.projectile;
  w.u32(e.id); w.entity(p.source); w.point(p.position); w.point(p.velocity); w.raw(p.damage); w.u32(p.activeFrom); w.u32(p.expiresAt);
}
function putHook(w: Writer, e: HookEntry): void {
  w.u32(e.id); w.actor(e.hook.owner);
  const start = w.length, p = e.hook.phase;
  if (p.kind === 'flying') { w.u32(0); w.point(p.position); w.point(p.direction); w.raw(p.travelled); }
  else { w.u32(1); w.actor(p.target); w.raw(p.length); }
  w.padTo(start + 6);
  w.u32(e.hook.expiresAt);
}
function putExtraction(w: Writer, e: Extraction | null): void { w.option(EXTRACTION_WORDS - 1, e, x => { w.point(x.position); w.u32(x.slots); }); }
function putTable<T>(w: Writer, rows: readonly T[], put: (row: T) => void): void { w.u32(rows.length); for (const row of rows) put(row); }

/** The state tables, in the order the module documentation gives. */
export function putState(w: Writer, s: State): void {
  putTable(w, s.actors, e => putActor(w, e));
  putTable(w, s.items, e => putItem(w, e.id, e.item));
  putTable(w, s.projectiles, e => putProjectile(w, e));
  putTable(w, s.hooks, e => putHook(w, e));
  putTable(w, s.gates, e => putGate(w, e));
  putTable(w, s.traps, e => putTrap(w, e));
  putTable(w, s.stations, e => putStation(w, e));
  putExtraction(w, s.extraction);
  w.u32(s.sensors.length);
  for (const p of s.sensors) w.point(p);
  w.option(1, s.hazardX, x => w.raw(x));
}

function putTuning(w: Writer, t: Tuning): void {
  const start = w.length, m = t.movement, h = m.hook;
  w.raw(...m.motor.baseSpeed, ...m.motor.boost, m.motor.stun, m.motor.sneak, m.motor.acceleration, m.motor.braking);
  w.raw(h.range, h.speed, h.maxForce, h.stiffness, h.damping, h.pullSpeed);
  w.u32(h.duration); w.u32(h.cooldown);
  w.raw(h.standoff, h.targetDistance, h.breakDistance);
  w.u32(m.boostDuration); w.u32(m.boostCooldown);
  for (const weapon of t.rules.weapons) {
    if (weapon.spread.length > MAX_SPREAD) bad('spread exceeds the codec');
    w.raw(weapon.damage, weapon.speed);
    w.u32(weapon.life); w.u32(weapon.cooldown); w.u32(weapon.spread.length);
    const at = w.length;
    w.raw(...weapon.spread);
    w.padTo(at + MAX_SPREAD);
  }
  w.raw(...t.rules.meleeDamage);
  w.u32(t.rules.wardenCooldown); w.u32(t.rules.specterCooldown); w.u32(t.rules.respawnTicks);
  w.option(6, t.rules.hearing, hearing => { w.raw(...hearing.ranges); w.u32(hearing.ticks); w.raw(hearing.width, hearing.height); });
  const i = t.items, d = i.drops;
  w.flag(i.reloading); w.flag(i.qualityDamage);
  w.u32(d.groundCapacity); w.u32(d.optionalBodyCapacity); w.u32(d.bodyCapacity); w.u32(d.dropReserve);
  w.u32(t.interactions.chargeTicks);
  w.raw(t.interactions.transitBase, t.interactions.transitPerUnit);
  const hz = t.hazards;
  w.raw(hz.mine.trigger, hz.mine.blast, hz.mine.damage, hz.mine.worldImpulse, hz.mine.actorImpulseLimit, hz.turret.range);
  w.u32(hz.turret.cooldown);
  w.raw(hz.turret.speed, hz.turret.damage);
  w.u32(hz.turret.life);
  w.u32(hz.flame.cycle); w.u32(hz.flame.warnAt); w.u32(hz.flame.fireAt); w.u32(hz.flame.interval);
  w.raw(hz.flame.range, hz.flame.cone, hz.flame.damage);
  w.raw(hz.spider.leash, hz.spider.acquire, hz.spider.step, hz.spider.grapple);
  w.u32(hz.spider.cooldown); w.u32(hz.spider.stun);
  w.raw(hz.spider.damage);
  if (w.length - start !== TUNING_WORDS) bad('tuning width');
}

/** A setup's words: `Setup::encode`'s layout. */
export function encodeSetup(setup: MatchSetup): Float64Array {
  const w = new Writer();
  if (!Number.isSafeInteger(setup.seed) || setup.seed < 0) bad('the seed must be a non-negative safe integer');
  w.u32(Math.floor(setup.seed / 2 ** 32)); w.u32(setup.seed % 2 ** 32);
  w.u32(setup.timeLimit);
  putState(w, setup.state);
  w.u32(setup.bodies.length);
  for (const { id, body: b } of setup.bodies) {
    const start = w.length;
    w.body(id); w.u32(b.kind); w.flag(b.mapGeometry); w.u32(b.shape); w.raw(b.a, b.b, ...b.pose, ...b.material);
    for (const damping of b.damping) w.option(1, damping, value => w.raw(value));
    w.u32(b.groups); w.flag(b.loot); w.raw(b.speedLimit, b.tipRadius);
    if (b.vertices.length % 2) bad(`body ${id.kind} ${id.id} has an odd vertex word count`);
    w.u32(b.vertices.length / 2);
    if (w.length - start !== BODY_HEADER) bad('a body header overran its layout');
    w.raw(...b.vertices);
  }
  w.u32(setup.motorSurfaces.length);
  for (const f of setup.motorSurfaces) {
    w.u32(f.idRank); w.raw(f.priority); w.point(f.origin); w.point(f.size); w.raw(f.speed, f.traction, f.braking);
    w.option(1, f.drag, drag => w.raw(drag));
  }
  w.raw(...setup.floorBases.loot, ...setup.floorBases.prop);
  w.u32(setup.hazardAreas.length);
  for (const area of setup.hazardAreas) w.raw(...area);
  w.option(2, setup.hazardWall, wall => { w.raw(wall.mapWidth); w.u32(wall.graceTicks); });
  w.option(4, setup.bounds, b => w.raw(...b));
  w.raw(setup.entryX ?? 0);
  putTuning(w, setup.tuning);
  const bots = setup.bots;
  w.flag(bots?.hearing ?? false);
  w.u32(bots?.hunting ?? 0);
  w.flag(bots?.portals ?? false);
  w.flag(bots?.selectableTransit ?? false);
  w.u32(bots?.roster.length ?? 0);
  for (const row of bots?.roster ?? []) {
    w.raw(row.actor); w.flag(row.opportunistic); w.flag(row.inventory); w.u32(row.rank);
  }
  return Float64Array.from(w.words);
}

function putTarget(w: Writer, t: Target): void { w.pick(TARGETS, t.kind, 'target'); w.u32('id' in t ? t.id : 0); }
function putInput(w: Writer, input: Input): void {
  const start = w.length;
  w.point(input.movement);
  w.option(1, input.aim, aim => w.raw(aim));
  w.flag(input.sneak); w.flag(input.attack);
  w.option(1, input.utilitySlot, slot => w.u32(slot));
  w.flag(input.skill); w.flag(input.interact);
  w.option(2, input.target, t => putTarget(w, t));
  w.option(1, input.slot, slot => w.u32(slot));
  w.option(2, input.moveSlot, ([from, to]) => { w.u32(from); w.u32(to); });
  w.option(2, input.drop, drop => { if (drop.kind === 'selected') { w.u32(0); w.u32(0); } else { w.u32(1); w.u32(drop.slot); } });
  w.flag(input.reload);
  w.option(2, input.dropAmmo, d => { w.pick(FAMILIES, d.family, 'family'); w.u32(d.count); });
  w.option(1, input.transit, station => w.u32(station));
  if (w.length - start !== INPUT_WORDS) bad('input width');
}
function putInbound(w: Writer, inbound: Inbound): void {
  const start = w.length;
  if (inbound.type === 'command') {
    const c = inbound.command;
    w.u32(0); w.actor(c.actor); w.pick(SOURCES, c.source, 'source'); w.u32(c.tick); w.int(c.seq); putInput(w, c.input);
  } else if (inbound.type === 'observation') {
    const o = inbound.observation;
    w.u32(1);
    switch (o.kind) {
      case 'viewLag': w.u32(0); w.actor(o.actor); w.u32(o.ticks); break;
      case 'inputLead': w.u32(1); w.actor(o.actor); w.u32(o.ticks); break;
      case 'join':
        w.u32(2); w.actor(o.actor); w.option(1, o.kit ?? null, kit => w.pick(KITS, kit, 'kit'));
        w.option(2, o.botLabel ?? null, label => { w.u32(label.rank); w.flag(label.opportunistic); });
        break;
      case 'leave': w.u32(3); w.actor(o.actor); break;
      case 'teleport': w.u32(4); w.body(o.body); w.point(o.to); break;
    }
  } else {
    const c = inbound.carried;
    w.u32(2);
    switch (c.kind) {
      case 'impulse': w.u32(0); w.body(c.body); w.point(c.impulse); break;
      case 'killReward': w.u32(1); w.actor(c.actor); break;
      case 'gateObserved': w.u32(2); w.actor(c.actor); w.u32(c.gate); w.flag(c.open); w.flag(c.locked); break;
    }
  }
  w.padTo(start + INBOUND_STRIDE);
}

/** Inbound rows for `match_submit`: `INBOUND_STRIDE` words each. */
export function encodeInbound(rows: readonly Inbound[]): Float64Array {
  const w = new Writer();
  for (const row of rows) putInbound(w, row);
  return Float64Array.from(w.words);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Reads words front to back; every failure throws, naming the word it stopped at. */
export class Reader {
  at = 0;
  readonly words: ArrayLike<number>;
  constructor(words: ArrayLike<number>) { this.words = words; }
  get empty(): boolean { return this.at === this.words.length; }
  fail(what: string): never { throw new RangeError(`tick-codec: ${what} at word ${this.at}`); }
  word(): number {
    if (this.at >= this.words.length) this.fail('truncated');
    return this.words[this.at++]!;
  }
  u64(): number {
    const word = this.word();
    if (!(word >= 0 && Number.isInteger(word) && word <= SAFE_INTEGER)) { this.at--; this.fail('not an integer'); }
    return word;
  }
  u32(): number {
    const word = this.u64();
    if (word >= 2 ** 32) { this.at--; this.fail('integer out of range'); }
    return word;
  }
  bool(): boolean {
    const word = this.word();
    if (word !== 0 && word !== 1) { this.at--; this.fail('not a bool'); }
    return word === 1;
  }
  /** A float word, which must be finite. */
  finite(): number {
    const word = this.word();
    if (!Number.isFinite(word)) { this.at--; this.fail('not finite'); }
    return word;
  }
  point(): Point { return [this.finite(), this.finite()]; }
  count(stride: number): number {
    const count = this.u32();
    if (count * stride > this.words.length - this.at) { this.at--; this.fail('count exceeds the buffer'); }
    return count;
  }
  skip(words: number): void {
    if (words > this.words.length - this.at) this.fail('truncated');
    this.at += words;
  }
  pick<T>(table: readonly T[]): T {
    const index = this.u32(), value = table[index];
    if (value === undefined) { this.at--; this.fail('unknown tag'); }
    return value;
  }
  padded<T>(width: number, read: () => T): T {
    const end = this.at + width;
    if (end > this.words.length) this.fail('truncated');
    const value = read();
    if (this.at > end) this.fail('payload overruns its row');
    this.at = end;
    return value;
  }
  option<T>(width: number, read: () => T): T | null {
    if (this.bool()) return read();
    this.skip(width);
    return null;
  }
  actor(): number {
    const word = this.u64();
    if (!actorOfWord(word)) { this.at--; this.fail('not an actor'); }
    return word;
  }
  entity(): Entity {
    const kind = this.pick(ENTITIES), id = this.u64();
    if (kind === 'actor' && !actorOfWord(id)) this.fail('not an actor');
    return { kind, id };
  }
  body(): BodyRef {
    const entity = this.entity();
    if (!BODY_KINDS.includes(entity.kind as BodyKind)) this.fail('not a body');
    return entity as BodyRef;
  }
}

function getEquipment(r: Reader): Equipment {
  const tag = r.u32();
  let kind: EquipmentKind;
  if (tag === 0) kind = { kind: 'firearm', weapon: r.pick(WEAPONS), rounds: r.u32() };
  else if (tag === 1) kind = { kind: 'stack', utility: r.pick(UTILITIES), count: r.u32() };
  else if (tag === 2) { kind = { kind: 'cell', charge: r.u32() }; r.skip(1); }
  else return r.fail('unknown equipment tag');
  return { kind, quality: r.u32() };
}
function getLoot(r: Reader): Loot {
  return r.padded(LOOT_WORDS, () => {
    const tag = r.u32();
    if (tag === 0) return { kind: 'accessKey' };
    if (tag === 1) return { kind: 'equipment', equipment: getEquipment(r) };
    if (tag === 2) return { kind: 'ammo', family: r.pick(FAMILIES), count: r.u32() };
    return r.fail('unknown loot tag');
  });
}
function getInventory(r: Reader): Inventory {
  const slots: (CarriedItem | null)[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) slots.push(r.option(2 + EQUIPMENT_WORDS, () => ({ id: r.u32(), lineage: r.u32(), equipment: getEquipment(r) })));
  const selected = r.u32(), reserves: [number, number, number] = [r.u32(), r.u32(), r.u32()], keys = r.u32();
  const reload = r.option(3, () => ({ slot: r.u32(), item: r.u32(), readyAt: r.u32() }));
  return { slots, selected, reserves, keys, reload };
}
function getActor(r: Reader): ActorEntry {
  const word = r.actor(), id = actorOfWord(word)!;
  const presence = r.pick(PRESENCE), kit = r.option(1, () => r.pick(KITS));
  const level = r.u32(), kills = r.u32();
  const hp = r.finite(), maxHp = r.finite(), shield = r.finite(), maxShield = r.finite(), aim = r.finite();
  const sneak = r.bool(), viewLag = r.u32(), inventory = getInventory(r);
  const charging = r.option(2, () => ({ station: r.u32(), cell: r.u32() }));
  const respawnAt = r.option(1, () => r.u32());
  const transit = r.option(4, () => ({ destination: r.u32(), origin: r.point(), arriveAt: r.u32() }));
  const bot = r.bool();
  const aggression = r.option(2, () => ({ source: r.actor(), expiresAt: r.u32() }));
  const deadlines = { skillReadyAt: r.u32(), weaponReadyAt: r.u32(), transitReadyAt: r.u32() };
  const statuses: Actor['statuses'] = {};
  for (const status of STATUSES) {
    const win = r.option(2, () => ({ activeFrom: r.u32(), expiresAt: r.u32() }));
    if (win) statuses[status] = win;
  }
  return { kind: id.kind, seat: id.seat, word, actor: { presence, kit, level, kills, hp, maxHp, shield, maxShield, aim, sneak, viewLag,
    inventory, charging, respawnAt, transit, bot, aggression, deadlines, statuses } };
}
// Keep the public decoded row's enumerable shape stable. Consumers that need the internal
// building slot must read it directly or copy it explicitly, since spread and structuredClone omit it.
function withBuilding<T extends object>(record: T, building: number | null): T {
  Object.defineProperty(record, 'building', { value: building, enumerable: false });
  return record;
}
function getItem(r: Reader): GroundEntry {
  const id = r.u32();
  const item = { loot: getLoot(r), lineage: r.option(1, () => r.u32()), unplacedAt: r.option(2, () => r.point()),
    droppedBy: r.option(1, () => r.actor()), pickupReadyAt: r.u32() };
  return { id, item: withBuilding(item, r.option(1, () => r.u32())) };
}
function getProjectile(r: Reader): ProjectileEntry {
  return { id: r.u32(), projectile: { source: r.entity(), position: r.point(), velocity: r.point(), damage: r.finite(), activeFrom: r.u32(), expiresAt: r.u32() } };
}
function getHook(r: Reader): HookEntry {
  const id = r.u32(), owner = r.actor(), tag = r.u32();
  const phase = r.padded<HookPhase>(5, () => tag === 0 ? { kind: 'flying', position: r.point(), direction: r.point(), travelled: r.finite() }
    : tag === 1 ? { kind: 'pulling', target: r.actor(), length: r.finite() } : r.fail('unknown hook phase'));
  return { id, hook: { owner, phase, expiresAt: r.u32() } };
}
function getGate(r: Reader): GateEntry {
  const id = r.u32(), gate = { open: r.bool(), locked: r.bool(), door: r.bool(), position: r.point() };
  return { id, gate: withBuilding(gate, r.option(1, () => r.u32())) };
}
function getTrap(r: Reader): TrapEntry {
  const id = r.u32(), position = r.point(), heading = r.finite(), readyAt = r.u32(), tag = r.u32();
  const kind = r.padded<TrapKind>(4, () => tag === 0 ? { kind: 'mine', spent: r.bool() } : tag === 1 ? { kind: 'turret', aiming: r.bool() }
    : tag === 2 ? { kind: 'flame', offset: r.u32(), warning: r.bool(), firing: r.bool() }
      : tag === 3 ? { kind: 'spider', home: r.point(), target: r.option(1, () => r.actor()) } : r.fail('unknown trap kind'));
  return { id, trap: { position, heading, readyAt, kind } };
}
function getStation(r: Reader): StationEntry { return { id: r.u32(), station: { kind: r.pick(STATION_KINDS), position: r.point() } }; }
function getExtraction(r: Reader): Extraction | null { return r.option(EXTRACTION_WORDS - 1, () => ({ position: r.point(), slots: r.u32() })); }
function getTable<T extends { id: number } | { word: number }>(r: Reader, stride: number, get: () => T): T[] {
  const count = r.count(stride), rows: T[] = [];
  for (let i = 0; i < count; i++) rows.push(get());
  return rows;
}
function getPoses(r: Reader): PoseEntry[] {
  const count = r.count(POSE_STRIDE), poses: PoseEntry[] = [];
  for (let i = 0; i < count; i++) poses.push({ body: r.body(), at: r.point(), angle: r.finite(), velocity: r.point(), spin: r.finite(), sleeping: r.bool() });
  return poses;
}
export function getState(r: Reader): State {
  const actors = getTable(r, ACTOR_STRIDE, () => getActor(r)), items = getTable(r, ITEM_STRIDE, () => getItem(r));
  const projectiles = getTable(r, PROJECTILE_STRIDE, () => getProjectile(r)), hooks = getTable(r, HOOK_STRIDE, () => getHook(r));
  const gates = getTable(r, GATE_STRIDE, () => getGate(r)), traps = getTable(r, TRAP_STRIDE, () => getTrap(r));
  const stations = getTable(r, STATION_STRIDE, () => getStation(r)), extraction = getExtraction(r);
  const count = r.count(2), sensors: Point[] = [];
  for (let i = 0; i < count; i++) sensors.push(r.point());
  return { actors, items, projectiles, hooks, gates, traps, stations, extraction, sensors, hazardX: r.option(1, () => r.finite()) };
}
export function decodeSnapshot(words: ArrayLike<number>): Snapshot {
  const r = new Reader(words), tick = r.u32(), state = getState(r), poses = getPoses(r);
  if (!r.empty) r.fail('trailing words');
  return { tick, state, poses };
}

function getRejection(r: Reader): Rejection {
  const tag = r.u32();
  return r.padded(3, (): Rejection => {
    switch (tag) {
      case 0: return { kind: 'skillCooldown' };
      case 1: return { kind: 'hookCapacity' };
      case 2: return { kind: 'drop' };
      case 3: return { kind: 'dropAmmo', family: r.pick(FAMILIES) };
      case 4: return { kind: 'reload' };
      case 5: return { kind: 'selectSlot' };
      case 6: return { kind: 'moveSlot' };
      case 7: return { kind: 'pickup', item: r.u32() };
      case 8: return { kind: 'swap', item: r.u32() };
      case 9: return { kind: 'interaction', target: r.option(2, () => getTarget(r)) };
      case 10: return { kind: 'gateLocked', gate: r.u32() };
      case 11: return { kind: 'gateOccupied', gate: r.u32() };
      case 12: return { kind: 'gateContested', gate: r.u32() };
      case 13: return { kind: 'transit', station: r.u32() };
      default: return r.fail('unknown rejection tag');
    }
  });
}
function getTarget(r: Reader): Target {
  const kind = r.pick(TARGETS), id = r.u32();
  return kind === 'extraction' || kind === 'unresolved' ? { kind } : { kind, id };
}
function getFact(r: Reader): Fact {
  const tag = r.u32();
  return r.padded(FACT_PAYLOAD, (): Fact => {
    switch (tag) {
      case 0: return { kind: 'hit', source: r.entity(), target: r.actor() };
      case 1: return { kind: 'rejected', actor: r.actor(), reason: getRejection(r) };
      case 2: return { kind: 'eliminated', actor: r.actor() };
      case 3: return { kind: 'respawned', actor: r.actor() };
      case 4: return { kind: 'killCredited', actor: r.actor(), target: r.actor() };
      case 5: return { kind: 'assisted', actor: r.actor(), target: r.actor() };
      case 6: return { kind: 'killRewarded', actor: r.actor() };
      case 7: return { kind: 'placed', source: r.entity(), placed: r.entity() };
      case 8: return { kind: 'boosted', actor: r.actor() };
      case 9: return { kind: 'shotFired', actor: r.actor(), weapon: r.pick(WEAPONS) };
      case 10: return { kind: 'reloadStarted', actor: r.actor(), readyAt: r.u32() };
      case 11: return { kind: 'reloaded', actor: r.actor(), weapon: r.pick(WEAPONS), rounds: r.u32() };
      case 12: return { kind: 'pickup', actor: r.actor(), item: r.u32(), count: r.u32() };
      case 13: return { kind: 'escaped', actor: r.actor(), cell: r.u32(), slots: r.u32() };
      case 14: return { kind: 'chargingStarted', actor: r.actor(), station: r.u32() };
      case 15: return { kind: 'chargingStopped', actor: r.actor(), station: r.u32() };
      case 16: return { kind: 'cellCharged', actor: r.actor(), station: r.u32() };
      case 17: return { kind: 'gateChanged', actor: r.actor(), gate: r.u32(), open: r.bool() };
      case 18: return { kind: 'gateObserved', actor: r.actor(), gate: r.u32(), open: r.bool(), locked: r.bool() };
      case 19: return { kind: 'transitDeparted', actor: r.actor(), station: r.u32() };
      case 20: return { kind: 'transitLanded', actor: r.actor(), station: r.u32() };
      case 21: return { kind: 'utilityUsed', actor: r.actor(), utility: r.pick(UTILITIES) };
      case 22: return { kind: 'meleeSwung', actor: r.actor() };
      case 23: return { kind: 'wardenPulsed', actor: r.actor() };
      case 24: return { kind: 'specterScanned', actor: r.actor() };
      case 25: return { kind: 'hookFired', owner: r.actor() };
      case 26: return { kind: 'hookAttached', owner: r.actor(), target: r.actor() };
      case 27: return { kind: 'hookReleased', owner: r.actor(), reason: r.pick(RELEASES) };
      case 28: return { kind: 'mineExploded', trap: r.u32() };
      case 29: return { kind: 'spiderGrappled', trap: r.u32(), target: r.actor(), at: r.point() };
      case 30: return { kind: 'heard', listener: r.actor(), at: r.point(), until: r.u32() };
      case 31: return { kind: 'contact', substep: r.u32(), a: r.body(), b: r.body(), contact: r.pick(CONTACTS) };
      case 32: return { kind: 'finished' };
      default: return r.fail('unknown fact tag');
    }
  });
}
function getEvent(r: Reader): GameEvent { return { id: r.u64(), tick: r.u32(), fact: getFact(r) }; }
function getChanges(r: Reader): Changes {
  const actors = getTable(r, ACTOR_STRIDE, () => getActor(r)), items = getTable(r, ITEM_STRIDE, () => getItem(r));
  const projectiles = getTable(r, PROJECTILE_STRIDE, () => getProjectile(r)), hooks = getTable(r, HOOK_STRIDE, () => getHook(r));
  const gates = getTable(r, GATE_STRIDE, () => getGate(r)), traps = getTable(r, TRAP_STRIDE, () => getTrap(r));
  const extraction = getExtraction(r), hazardX = r.option(1, () => r.finite());
  let count = r.count(2);
  const removed: Entity[] = [];
  for (let i = 0; i < count; i++) removed.push(r.entity());
  const poses = getPoses(r);
  count = r.count(EVENT_STRIDE);
  const events: GameEvent[] = [];
  for (let i = 0; i < count; i++) events.push(getEvent(r));
  return { actors, items, projectiles, hooks, gates, traps, extraction, hazardX, removed, poses, events };
}

function getInput(r: Reader): Input {
  return { movement: r.point(), aim: r.option(1, () => r.finite()), sneak: r.bool(), attack: r.bool(), utilitySlot: r.option(1, () => r.u32()),
    skill: r.bool(), interact: r.bool(), target: r.option(2, () => getTarget(r)), slot: r.option(1, () => r.u32()),
    moveSlot: r.option(2, () => [r.u32(), r.u32()] as const),
    drop: r.option(2, (): DropSlot => { const tag = r.u32(), slot = r.u32(); return tag === 0 ? { kind: 'selected' } : tag === 1 ? { kind: 'slot', slot } : r.fail('unknown drop tag'); }),
    reload: r.bool(), dropAmmo: r.option(2, () => ({ family: r.pick(FAMILIES), count: r.u32() })), transit: r.option(1, () => r.u32()) };
}
function getInbound(r: Reader): Inbound {
  const tag = r.u32();
  return r.padded(INBOUND_STRIDE - 1, (): Inbound => {
    if (tag === 0) return { type: 'command', command: { actor: r.actor(), source: r.pick(SOURCES), tick: r.u32(), seq: r.u64(), input: getInput(r) } };
    if (tag === 1) {
      const kind = r.u32();
      const observation: Observation = kind === 0 ? { kind: 'viewLag', actor: r.actor(), ticks: r.u32() }
        : kind === 1 ? { kind: 'inputLead', actor: r.actor(), ticks: r.u32() }
          : kind === 2 ? getJoin(r) : kind === 3 ? { kind: 'leave', actor: r.actor() }
            : kind === 4 ? { kind: 'teleport', body: r.body(), to: r.point() } : r.fail('unknown observation tag');
      return { type: 'observation', observation };
    }
    if (tag === 2) {
      const kind = r.u32();
      const carried: Carried = kind === 0 ? { kind: 'impulse', body: r.body(), impulse: r.point() }
        : kind === 1 ? { kind: 'killReward', actor: r.actor() }
          : kind === 2 ? { kind: 'gateObserved', actor: r.actor(), gate: r.u32(), open: r.bool(), locked: r.bool() } : r.fail('unknown carried tag');
      return { type: 'carried', carried };
    }
    return r.fail('unknown inbound tag');
  });
}
function getJoin(r: Reader): Observation {
  const actor = r.actor(), kit = r.option(1, () => r.pick(KITS));
  const botLabel = r.option(2, () => ({ rank: r.u32(), opportunistic: r.bool() }));
  return { kind: 'join', actor, ...(kit === null ? {} : { kit }), ...(botLabel === null ? {} : { botLabel }) };
}
function getDiscontinuity(r: Reader): Discontinuity {
  const tag = r.u32(), body = r.body();
  const request = r.u32();
  if (tag === 3) return { kind: 'devWarped', body, request };
  if (request !== 0) return r.fail('invalid discontinuity padding');
  return { kind: tag === 0 ? 'placed' : tag === 1 ? 'warped' : tag === 2 ? 'removed' : r.fail('unknown discontinuity tag'), body };
}
function getDiscovery(r: Reader): Discovery {
  let count = r.count(GATE_OBSERVATION_STRIDE);
  const gates: GateObservation[] = [];
  for (let i = 0; i < count; i++) gates.push({ actor: r.actor(), gate: r.u32(), open: r.bool(), locked: r.bool() });
  count = r.count(SAMPLE_STRIDE);
  const samples: DiscoverySample[] = [];
  for (let i = 0; i < count; i++) samples.push({ actor: r.actor(), eye: r.point() });
  return { gates, samples };
}

/** A completed tick: `match_step`'s words. The solved paths stay in Rust. */
export function decodeCompleted(words: ArrayLike<number>): DecodedTick {
  const r = new Reader(words), tick = r.u32();
  let count = r.count(INBOUND_STRIDE);
  const inbound: Inbound[] = [];
  for (let i = 0; i < count; i++) inbound.push(getInbound(r));
  const changes = getChanges(r);
  count = r.count(DISCONTINUITY_STRIDE);
  const discontinuities: Discontinuity[] = [];
  for (let i = 0; i < count; i++) discontinuities.push(getDiscontinuity(r));
  const discovery = getDiscovery(r);
  const completed = { tick, inbound, changes, discontinuities, discovery };
  if (!r.empty) {
    const botRoutes = Array.from({ length: r.count(2) }, () => ({ actor: r.actor(),
      route: Array.from({ length: r.count(2) }, () => ({ x: r.finite(), y: r.finite() })) }));
    // Private frame compatibility data rides on the same transfer. The committed tick's transcript is unchanged.
    Object.defineProperty(completed, 'botRoutes', { value: botRoutes });
  }
  if (!r.empty) r.fail('trailing words');
  return completed;
}

function getCells(r: Reader): number[] {
  const count = r.count(1), cells: number[] = [];
  for (let i = 0; i < count; i++) cells.push(r.u32());
  return cells;
}
/** A contestant's memory: `match_memory`'s words, null for none (the one word 0). */
export function decodeMemory(words: ArrayLike<number>): Memory | null {
  const r = new Reader(words);
  if (!r.bool()) { if (!r.empty) r.fail('trailing words'); return null; }
  const discovered = getCells(r), seen = getCells(r), surveyed = getCells(r);
  let count = r.count(REMEMBERED_ITEM_STRIDE);
  const items: RememberedItem[] = [];
  for (let i = 0; i < count; i++) { const at = r.point(), { id, item } = getItem(r); items.push({ id, at, item }); }
  count = r.count(DOOR_MEMORY_STRIDE);
  const gates: DoorMemory[] = [];
  for (let i = 0; i < count; i++) gates.push({ gate: r.u32(), open: r.bool(), locked: r.bool() });
  const memory = { discovered, seen, surveyed, items, gates, revision: r.u64() };
  if (!r.empty) r.fail('trailing words');
  return memory;
}
/** A listener's cues, oldest first: `match_heard`'s words (a count word, then rows). */
export function decodeCues(words: ArrayLike<number>): Cue[] {
  const r = new Reader(words), count = r.count(CUE_STRIDE), cues: Cue[] = [];
  for (let i = 0; i < count; i++) cues.push({ at: r.point(), tick: r.u32(), until: r.u32() });
  if (!r.empty) r.fail('trailing words');
  return cues;
}

// ---------------------------------------------------------------------------
// Folding a change list into a snapshot (`Snapshot::apply`)
// ---------------------------------------------------------------------------

/** Replace by ID, or add, keeping ascending ID order. */
function upsert<T>(rows: readonly T[], changed: readonly T[], idOf: (row: T) => number): T[] {
  if (!changed.length) return rows as T[];
  const byId = new Map(rows.map(row => [idOf(row), row] as const));
  for (const row of changed) byId.set(idOf(row), row);
  return [...byId.values()].sort((a, b) => idOf(a) - idOf(b));
}
const BODY_RANK: Record<BodyKind, number> = { actor: 0, item: 1, prop: 2, gate: 3, geometry: 4 };
/** Bodies in `BodyId` order: actor, item, prop, gate, geometry, then ID. */
export const bodyOrder = (a: BodyRef, b: BodyRef): number => BODY_RANK[a.kind] - BODY_RANK[b.kind] || a.id - b.id;
/** A body's key in a map: `kind:id`. */
export const bodyKey = (body: BodyRef): string => `${body.kind}:${body.id}`;

/**
 * `Snapshot::apply`: the previous tick's snapshot becomes this tick's. Changed records replace whole, removals follow, a
 * `removed` marker drops a body's pose, then the changed poses are written. Returns a new snapshot, sharing the rows it
 * leaves alone; poses stay in `BodyId` order (actor, item, prop, gate, geometry, then ID).
 */
export function foldChanges(snapshot: Snapshot, tick: Tick, changes: Changes, discontinuities: readonly Discontinuity[]): Snapshot {
  const s = snapshot.state;
  let items = upsert(s.items, changes.items, e => e.id);
  let projectiles = upsert(s.projectiles, changes.projectiles, e => e.id);
  let hooks = upsert(s.hooks, changes.hooks, e => e.id);
  for (const gone of changes.removed) {
    if (gone.kind === 'item') items = items.filter(e => e.id !== gone.id);
    else if (gone.kind === 'projectile') projectiles = projectiles.filter(e => e.id !== gone.id);
    else if (gone.kind === 'hook') hooks = hooks.filter(e => e.id !== gone.id);
    else throw new RangeError(`tick-codec: ${gone.kind} is never removed`);
  }
  const state: State = { actors: upsert(s.actors, changes.actors, e => e.word), items, projectiles, hooks,
    gates: upsert(s.gates, changes.gates, e => e.id), traps: upsert(s.traps, changes.traps, e => e.id), stations: s.stations,
    extraction: changes.extraction ?? s.extraction, sensors: s.sensors, hazardX: changes.hazardX ?? s.hazardX };
  const poses = new Map(snapshot.poses.map(p => [bodyKey(p.body), p] as const));
  for (const marker of discontinuities) if (marker.kind === 'removed') poses.delete(bodyKey(marker.body));
  for (const pose of changes.poses) poses.set(bodyKey(pose.body), pose);
  return { tick, state, poses: [...poses.values()].sort((a, b) => bodyOrder(a.body, b.body)) };
}
