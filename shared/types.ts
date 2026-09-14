// The shared type vocabulary. Everything the simulation, the server and the client exchange is
// named here once, so a field's meaning travels with it instead of decaying into `number`.
//
// Branding policy, chosen for cost rather than purity:
//   * Identifiers are branded. They are strings that are never arithmetic, so a brand costs one
//     cast at the single place each id is minted and catches every gate-id-for-item-id mix-up.
//   * Tile coordinates are branded. The arena has four coexisting coordinate spaces (below) and
//     tile arithmetic is confined to `simulation/geometry`, `map/navigation` and the bot repath
//     block, so the brand pays for itself there without spreading casts through the codebase.
//   * World coordinates and tick counts are plain `number` aliases. They are combined
//     arithmetically on nearly every line; branding them would demand a cast per expression and
//     buy less than the named parameter and field types already give.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

// ---------------------------------------------------------------------------
// Coordinate spaces
// ---------------------------------------------------------------------------

/**
 * World units. The arena is 24,000 x 12,000 of them; players, items and obstacles all live here.
 * Distinct from {@link TileIndex}, which counts 40-unit navigation samples.
 */
export type World = number;

/** A point in world space. */
export interface Vec2 {
  x: World;
  y: World;
}

/**
 * A navigation-grid column or row: world units divided by `TILE`. Only the pathfinding sampler
 * and bot repathing speak this; nothing renders or collides against it.
 */
export type TileIndex = Brand<number, 'TileIndex'>;
/** A count of tiles — a width, height or span rather than a position. */
export type TileCount = Brand<number, 'TileCount'>;

/** A point in tile space. */
export interface TilePoint {
  x: TileIndex;
  y: TileIndex;
}

/** A tile-space rectangle. `navigationGrid` bounds are this, never a world-space box. */
export interface TileRect {
  x: TileIndex;
  y: TileIndex;
  width: TileCount;
  height: TileCount;
}

/** A waypoint on a bot path, in absolute tile coordinates. */
export type TileStep = readonly [TileIndex, TileIndex];

/** A world-space axis-aligned box. */
export interface Box {
  x: World;
  y: World;
  w: World;
  h: World;
}

/** A world-space viewport, which names its extents `width`/`height` rather than `w`/`h`. */
export interface ViewBounds {
  x: World;
  y: World;
  width: World;
  height: World;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * A simulation tick count, at `HZ` ticks per second — either an absolute tick or a duration.
 * Every `cooldown`, `life`, `charge` and `*Cd` field in this file is measured in these, and
 * none of them are world units even though both are numbers.
 */
export type Tick = number;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type PlayerId = Brand<string, 'PlayerId'>;
export type ObstacleId = Brand<string, 'ObstacleId'>;
export type GateId = Brand<string, 'GateId'>;
export type BuildingId = Brand<string, 'BuildingId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type StationId = Brand<string, 'StationId'>;
export type ChargerId = Brand<string, 'ChargerId'>;
export type SensorId = Brand<string, 'SensorId'>;
export type TrapId = Brand<string, 'TrapId'>;
/** Block-graph node key, formatted `"<col>,<row>"`. */
export type NodeId = Brand<string, 'NodeId'>;
/** Serial number shared by projectiles, effects and events, drawn from `Game.serial`. */
export type Serial = number;

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

export type Role = 'contestant' | 'gladiator';
export type Kit = 'warden' | 'specter' | 'striker';
export type Phase = 'live' | 'finished';
export type PlayerStatus = 'active' | 'eliminated' | 'respawning' | 'escaped' | 'stranded';
export type WeaponType = 'pistol' | 'rifle' | 'scattergun';
export type ItemKind = 'weapon' | 'med' | 'shield' | 'cell' | 'access';
export type StackKind = 'med' | 'shield';
export type TrapKind = 'mine' | 'turret' | 'flame' | 'spider';
export type ObstacleKind = 'ruin-wall' | 'building' | 'window' | 'container' | 'crate';
export type ModuleKind = 'yard' | 'depot' | 'garden';
export type RouteBand = 'main' | 'top' | 'bottom';
export type EffectKind = 'shock' | 'scan' | 'slash' | 'loot' | 'upgrade' | 'rail' | 'charge' | 'grapple';
export type SlotIndex = number;

/**
 * Which doors a navigation grid may route through: `false` respects gate state, `true` routes
 * through unlocked doors, `'all'` ignores locks entirely. Not a boolean — the third case is the
 * one a contestant holding an access charge uses.
 */
export type DoorPermission = boolean | 'all';

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

export interface WeaponSpec {
  name: string;
  ammo: number;
  maxAmmo: number;
  cooldown: Tick;
  damage: number;
  speed: World;
  life: Tick;
  /** Radian offsets applied to the firing heading, one projectile each. */
  spread: number[];
}

export interface KitSpec {
  name: string;
  color: number;
  damage: number;
  cooldown: Tick;
  skill: string;
}

export interface WeaponItem {
  kind: 'weapon';
  weaponType: WeaponType;
  ammo: number;
}
export interface CellItem {
  kind: 'cell';
  charge: Tick;
}
export interface StackItem {
  kind: StackKind;
  count: number;
}

/** A carried item. The discriminant guarantees `ammo`, `charge` and `count` cannot be confused. */
export type InventoryItem = WeaponItem | CellItem | StackItem;

/** A fixed-length array of `SLOT_COUNT` slots, each either an item or empty. */
export type Inventory = (InventoryItem | null)[];

/**
 * An item lying in the world. It is deliberately wider than {@link InventoryItem}: generated loot
 * carries placement metadata, and the optional payload fields depend on `kind`.
 */
export interface GroundItem {
  id: ItemId;
  x: World;
  y: World;
  kind: ItemKind;
  weaponType?: WeaponType | undefined;
  ammo?: number | undefined;
  charge?: Tick | undefined;
  count?: number | undefined;
  buildingId?: BuildingId | undefined;
  droppedBy?: PlayerId | undefined;
  pickupAfter?: Tick | undefined;
  nodeId?: NodeId | undefined;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export interface MapNode extends Vec2 {
  id: NodeId;
  col: number;
  row: number;
  neighbors: NodeId[];
}

export interface Obstacle extends Box {
  id: ObstacleId;
  kind: ObstacleKind;
  /** Radius, for the circular obstacle form the collision code still supports. */
  r?: number | undefined;
  /**
   * A convex outline in points local to `x`,`y`, for generated geometry that is neither a box nor a
   * circle. Collision, sight and rendering all read it through `shape.ts`. Absent on every recorded
   * map so far, so older recordings keep their box/circle meaning unchanged.
   */
  points?: Vec2[] | undefined;
  buildingId?: BuildingId | undefined;
  color?: number | undefined;
}

export interface Gate {
  id: GateId;
  x: World;
  y: World;
  w: World;
  h: World;
  open: boolean;
  locked: boolean;
  kind: 'door';
  buildingId?: BuildingId | undefined;
}

export interface Building extends Box {
  id: BuildingId;
  nodeId: NodeId;
}

export interface MapModule extends Vec2 {
  /** Module ids are the node's array index, not a minted string id. */
  id: number;
  width: World;
  height: World;
  kind: ModuleKind;
}

export interface Station extends Vec2 {
  id: StationId;
  nodeId: NodeId;
}
export interface Charger extends Vec2 {
  id: ChargerId;
  nodeId: NodeId;
}
export interface Sensor extends Vec2 {
  id: SensorId;
}

export interface Trap extends Vec2 {
  id: TrapId;
  kind: TrapKind;
  homeX: World;
  homeY: World;
  heading: number;
  /** Per-trap phase offset, so identical traps do not fire in lockstep. */
  offset: Tick;
  cooldown: Tick;
  spent: boolean;
  aiming?: boolean | undefined;
  firing?: boolean | undefined;
  warning?: boolean | undefined;
  targetId?: PlayerId | null | undefined;
}

export interface Street {
  a: Vec2;
  /** The offset doorway between the two block centres. */
  port: Vec2;
  b: Vec2;
}

export interface Route {
  band: RouteBand;
  points: Vec2[];
}

export interface GameMap {
  seed: number;
  width: World;
  height: World;
  modules: MapModule[];
  buildings: Building[];
  obstacles: Obstacle[];
  gates: Gate[];
  hazards: Box[];
  /** Narrow shortcuts that pass a contestant but not a gladiator. */
  gaps: Vec2[];
  stations: Station[];
  chargers: Charger[];
  sensors: Sensor[];
  items: GroundItem[];
  traps: Trap[];
  routes: Route[];
  nodes: MapNode[];
  streets: Street[];
  entry: Vec2;
  exit: Vec2;
  spawns: Vec2[];
}

/**
 * The map fields the geometry code reads. Narrower than {@link GameMap} on purpose: collision and
 * sight queries run during generation, before objectives or spawns exist.
 */
export type CollisionMap = Pick<GameMap, 'width' | 'height' | 'obstacles' | 'gates'>;

/** The map as generation builds it. Each stage's output is absent until that stage has run. */
export type MapDraft = Omit<GameMap, 'entry' | 'exit' | 'spawns'> & Partial<Pick<GameMap, 'entry' | 'exit' | 'spawns'>>;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** A slot rearrangement request: move or merge the item in `from` into `to`. */
export interface SlotMove {
  from: SlotIndex;
  to: SlotIndex;
}

/**
 * One client's intent for a tick. Every field is optional because a stale or absent client is
 * represented by an empty object, and because bots emit only the fields they mean to drive.
 */
export interface PlayerInput {
  /** Movement axes, each clamped to [-1, 1]. */
  x?: number | undefined;
  y?: number | undefined;
  /** Aim heading in radians. */
  aim?: number | undefined;
  attack?: boolean | undefined;
  skill?: boolean | undefined;
  interact?: boolean | undefined;
  drop?: boolean | undefined;
  sneak?: boolean | undefined;
  slot?: SlotIndex | undefined;
  moveSlot?: SlotMove | undefined;
  /** Monotonic client sequence number; the server rejects anything not newer than the last. */
  seq?: number | undefined;
}

export interface Player extends Vec2 {
  id: PlayerId;
  name: string;
  role: Role;
  kit: Kit;
  bot: boolean;
  hp: number;
  maxHp: number;
  shield: number;
  /** Access charges held, spent on locked doors. */
  keys: number;
  /** Renderer weapon index: 0 for none, otherwise the `WEAPONS` key order plus one. */
  weapon: number;
  kills: number;
  level: number;
  status: PlayerStatus;
  cooldown: Tick;
  attackCd: Tick;
  railCd: Tick;
  cloak: Tick;
  revealed: Tick;
  boost: Tick;
  stun: Tick;
  heading: number;
  input: PlayerInput;
  /** The newest sequence a tick has *consumed*. What the client reconciles against. */
  lastSeq: number;
  /** Inputs accepted but not yet spent. A tick spends exactly one. */
  inputQueue?: PlayerInput[] | undefined;
  /** The newest sequence *accepted*, which guards ordering and duplicates on arrival. */
  receivedSeq?: number | undefined;
  /** Consecutive ticks the queue has been empty, so a repeat is distinguishable from a real input. */
  inputStalled?: number | undefined;
  inventory?: Inventory | undefined;
  selectedSlot?: SlotIndex | undefined;
  /** Remaining bot route, in absolute tile coordinates. Not world units. */
  path?: TileStep[] | undefined;
  /** The charger being used, or null when not charging. */
  charging?: ChargerId | null | undefined;
  respawnAt?: Tick | null | undefined;
  /** The tick the last client packet was accepted on, used to expire stale input. */
  inputTick?: Tick | undefined;
  /** World distance covered this tick; motion mines read it. */
  movedThisTick?: World | undefined;
  aggressor?: PlayerId | undefined;
  aggressionUntil?: Tick | undefined;
}

export interface Projectile extends Vec2 {
  id: Serial;
  /** The player or trap that fired it. */
  owner: PlayerId | TrapId;
  trap?: boolean | undefined;
  dx: World;
  dy: World;
  life: Tick;
  damage: number;
}

export interface Effect extends Vec2 {
  id: Serial;
  kind: EffectKind;
  radius: World;
  life: Tick;
}

export interface GameEvent {
  id: Serial;
  tick: Tick;
  text: string;
}

export interface Game {
  version: string;
  seed: number;
  /** Seeded PRNG state, carried in snapshots so a replay resumes the same stream. */
  rng: number;
  tick: Tick;
  phase: Phase;
  map: GameMap;
  players: Player[];
  projectiles: Projectile[];
  effects: Effect[];
  events: GameEvent[];
  /** Escape pod slots still unclaimed. */
  slots: number;
  /** World x of the advancing wall; anything west of it takes damage. */
  hazardX: World;
  serial: Serial;
}

/** A complete authoritative state clone, as recorded and as sent to spectators. */
export interface Snapshot {
  version: string;
  duration: Tick;
  cellChargeTicks: Tick;
  tick: Tick;
  phase: Phase;
  rng: number;
  hazardX: World;
  slots: number;
  serial: Serial;
  players: Player[];
  items: GroundItem[];
  gates: Gate[];
  traps: Trap[];
  projectiles: Projectile[];
  effects: Effect[];
  events: GameEvent[];
}

/**
 * A record produced by a projection contract: the permitted subset of a source object, plus the
 * legacy keys older recordings still carry. It is wire data, never a live simulation object.
 */
export type Projected<T> = Partial<T> & Record<string, unknown>;

/** A gate as the client remembers it, which may be stale rather than current. */
export interface ObservedGate extends Gate {
  known: boolean;
  stale: boolean;
  lastSeenTick?: Tick | undefined;
}
