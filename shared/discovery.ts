import { createFrameNormalizer } from './relational-frame.ts';
import type { CoreSight, DiscoveryTables } from './sight-core.ts';
import { gateShape, gatesNear } from './gate-index.ts';
import { insideMap } from './playable-area.ts';
import { itemsNear } from './simulation/ground-items.ts';
import { ItemMemory, SeenCells, rememberedItems } from './simulation/bot-memory.ts';
import { MAX_VIEW_HEIGHT, MAX_VIEW_WIDTH, roofTables } from './view.ts';
import { nextVersion } from './frame-layers.ts';
import { count } from './profiler.ts';
import type { CollisionMap, DiscoveryMemory, DiscoveryWire, GameMap, Gate, GateObservation, GroundItem, ItemId, Player, PlayerId, Role, Vec2, World } from './types.ts';
export type { DiscoveryMemory, DiscoveryWire };

/** The side length of a coarse discovery cell in world units (4 x 48 map cells). */
export const DISCOVERY_CELL_SIZE: World = 192;
/** How far a bot's line of sight reaches when it looks for dynamic state: loot and cells (#230). */
export const DISCOVERY_RADIUS: World = 1200;
/** The window world geometry is discovered within: the largest viewport a client may have (`view.ts`). */
export const DISCOVERY_VIEW = { halfWidth: MAX_VIEW_WIDTH / 2, halfHeight: MAX_VIEW_HEIGHT / 2 } as const;
/** How often a contestant samples discovery, staggered per player. */
export const DISCOVERY_INTERVAL = 10;
/**
 * How far a landmark (charger, exit, transit station) is discovered from, regardless of walls and
 * roofs: it carries a beacon, so finding one is not a search of the whole map (#230).
 */
export const BEACON_RADIUS: World = 4000;

/** The map fields discovery reads. Items and landmarks are optional, so a bare collision map works. */
export type DiscoveryMap = CollisionMap & Pick<GameMap, 'buildings'> & Partial<Pick<GameMap<ItemId>, 'items' | 'chargers' | 'stations' | 'exit' | 'roofs'>>;

/** The features that carry a beacon. */
function landmarks(map: DiscoveryMap): Vec2[] {
  return [...map.chargers ?? [], ...map.stations ?? [], ...map.exit ? [map.exit] : []];
}

export interface DiscoveryGrid {
  cols: number;
  rows: number;
  size: World;
}

/** Compute the dimensions of the coarse discovery grid over map dimensions. */
export function discoveryGrid(map: Pick<CollisionMap, 'width' | 'height'>): DiscoveryGrid {
  return {
    cols: Math.ceil(map.width / DISCOVERY_CELL_SIZE),
    rows: Math.ceil(map.height / DISCOVERY_CELL_SIZE),
    size: DISCOVERY_CELL_SIZE,
  };
}

/** The flat grid cell index containing a world coordinate, or -1 if outside bounds. */
export function cellIndexAt(map: Pick<CollisionMap, 'width' | 'height'>, x: World, y: World): number {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return -1;
  const { cols } = discoveryGrid(map);
  const col = Math.floor(x / DISCOVERY_CELL_SIZE);
  const row = Math.floor(y / DISCOVERY_CELL_SIZE);
  return row * cols + col;
}

/** The world center point of a flat grid cell index. */
export function cellCenter(map: Pick<CollisionMap, 'width' | 'height'>, index: number): Vec2 {
  const { cols } = discoveryGrid(map);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: col * DISCOVERY_CELL_SIZE + DISCOVERY_CELL_SIZE / 2,
    y: row * DISCOVERY_CELL_SIZE + DISCOVERY_CELL_SIZE / 2,
  };
}

/** Create empty authoritative discovery memory. */
export function createDiscovery(): DiscoveryMemory {
  return {
    discovered: new Set<number>(),
  };
}

/** Attach discovery memory to a player as non-enumerable authoritative state. */
export function attachDiscovery(player: Player, memory: DiscoveryMemory): void {
  Object.defineProperty(player, 'discovery', { value: memory, writable: true, configurable: true, enumerable: false });
}

/** Check whether a world point falls inside an already-discovered cell. */
export function isDiscovered(memory: DiscoveryMemory | null | undefined, map: Pick<CollisionMap, 'width' | 'height'>, x: World, y: World): boolean {
  if (!memory) return false;
  const idx = cellIndexAt(map, x, y);
  return idx !== -1 && memory.discovered.has(idx);
}

/** Check whether a map feature (station, charger, exit, item) has been discovered. */
export function isFeatureDiscovered(memory: DiscoveryMemory | null | undefined, map: Pick<CollisionMap, 'width' | 'height'>, feature: Vec2): boolean {
  return isDiscovered(memory, map, feature.x, feature.y);
}

/**
 * What discovery uploads to the core for a map, once (`rust/core/src/discovery.rs`): the grid and the rule's
 * constants, which cells' centres are playable ground, the landmarks with their cells, and the roofs.
 */
export function discoveryTables(map: DiscoveryMap): DiscoveryTables {
  const { cols, rows } = discoveryGrid(map), inside = new Uint8Array(cols * rows);
  for (let idx = 0; idx < inside.length; idx++) {
    const { x, y } = cellCenter(map, idx);
    inside[idx] = insideMap(map, x, y) ? 1 : 0;
  }
  const constants = Float64Array.of(cols, rows, DISCOVERY_CELL_SIZE, DISCOVERY_VIEW.halfWidth, DISCOVERY_VIEW.halfHeight, BEACON_RADIUS);
  const beacons = Float64Array.from(landmarks(map).flatMap(l => [l.x, l.y, cellIndexAt(map, l.x, l.y)]));
  return { constants, inside, landmarks: beacons, ...roofTables(map) };
}

/** The input header's words: `rust/core/src/discovery.rs`'s `HEADER`. */
const HEADER = 11;

/**
 * Sample discovery from an eye position against the map. Two rules, split by what is learned (Corey,
 * 2026-10-14, 15):
 * - **World geometry** is learned from the view window: every cell whose centre lies within the largest
 *   viewport a client may have is discovered, regardless of walls and roofs. Landmarks are discovered
 *   from their beacon radius. This is what the minimap draws.
 * - **Dynamic state** needs line of sight. A sample `lineOfSight` (bots, #230) casts one visibility
 *   polygon and marks the cells whose centres are lit and not roof-concealed as `memory.seen`, which a
 *   bot searches against, and updates `memory.items`: items in sight are remembered, and a remembered
 *   item whose spot is seen empty is forgotten. Doors in sight are remembered as they stand
 *   (`memory.gates`), and every cell the view window covers is `memory.surveyed`, the layout navigation
 *   may treat as known (22.6).
 * Returns the newly discovered cell indices; `memory.revision` counts each sample that changed anything.
 *
 * The rule runs in the core (#1210, docs/27 "The state flip"), through `sight`, the game's core binding
 * (`sightOf(s)`). The memory stays here: this packs what the sample reads near the eye, and applies what
 * it learned in the order the rule writes it, which is the order a bot's ties are broken in.
 */
export function discover(
  sight: CoreSight,
  memory: DiscoveryMemory,
  map: DiscoveryMap,
  eye: Vec2,
  radius: World = DISCOVERY_RADIUS,
  lineOfSight = false
): number[] {
  const { cols, rows } = discoveryGrid(map);
  let near: readonly GroundItem<ItemId>[] = [], held: readonly GroundItem<ItemId>[] = [], doors: Gate[] = [];
  let items: ItemMemory | undefined, seen: Set<number> | undefined;
  // The reach window, as the rule visits it; empty for an eye that is not a number.
  let c0 = 0, c1 = -1, r0 = 0, r1 = -1;
  if (lineOfSight) {
    seen = memory.seen ??= new SeenCells(cols, rows);
    if (map.items) {
      items = rememberedItems(memory) ?? (memory.items = new ItemMemory());
      near = itemsNear(map.items, eye, radius);
      held = [...items.cellItems(), ...items.near(eye, radius)];
    }
    doors = gatesNear(map, eye.x - radius, eye.y - radius, eye.x + radius, eye.y + radius);
    const minCol = Math.max(0, Math.floor((eye.x - radius) / DISCOVERY_CELL_SIZE)), maxCol = Math.min(cols - 1, Math.floor((eye.x + radius) / DISCOVERY_CELL_SIZE));
    const minRow = Math.max(0, Math.floor((eye.y - radius) / DISCOVERY_CELL_SIZE)), maxRow = Math.min(rows - 1, Math.floor((eye.y + radius) / DISCOVERY_CELL_SIZE));
    if (minCol <= maxCol && minRow <= maxRow) [c0, c1, r0, r1] = [minCol, maxCol, minRow, maxRow];
  }
  const width = c1 - c0 + 1, things = HEADER + (near.length + held.length) * 2 + doors.length * 4;
  const out = sight.sampleDiscovery(map, discoveryTables, lineOfSight, things + width * (r1 - r0 + 1), input => {
    input.set([eye.x, eye.y, radius, lineOfSight ? 1 : 0, near.length, held.length, doors.length, c0, c1, r0, r1]);
    let at = HEADER;
    for (const item of near) { input[at++] = item.x; input[at++] = item.y; }
    for (const item of held) { input[at++] = item.x; input[at++] = item.y; }
    for (const gate of doors) { const box = gateShape(gate); input[at++] = box.x; input[at++] = box.y; input[at++] = box.w; input[at++] = box.h; }
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) input[at++] = seen!.has(row * cols + col) ? 1 : 0;
  });

  if (out[0]) { count('calls.visibilityPolygon'); count('work.visibilityRays', out[1]); }
  let at = 2, changed = false;
  const newlyDiscovered: number[] = [];
  for (let n = out[at++]!; n > 0; n--) {
    const idx = out[at++]!;
    if (!memory.discovered.has(idx)) { memory.discovered.add(idx); newlyDiscovered.push(idx); }
  }
  const surveyedCount = out[at++]!;
  if (lineOfSight) {
    const surveyed = memory.surveyed ??= new Set();
    for (let i = 0; i < surveyedCount; i++) { const idx = out[at + i]!; if (!surveyed.has(idx)) { surveyed.add(idx); changed = true; } }
  }
  at += surveyedCount;
  for (let n = out[at++]!; n > 0; n--) seen!.add(out[at++]!);
  if (lineOfSight) {
    if (items) {
      const present = new Set<ItemId>();
      for (const item of near) if (out[at++]) { present.add(item.id); items.set(item.id, { ...item }); }
      for (const item of held) if (out[at++] && !present.has(item.id)) items.delete(item.id);
    }
    for (const gate of doors) if (out[at++]) changed = observeGate(memory, gate, false) || changed;
  }

  if (changed || newlyDiscovered.length) memory.revision = (memory.revision ?? 0) + 1;
  return newlyDiscovered;
}

/**
 * Remember a door as it stands, seen or tried (22.6, "Doors"). Returns whether the memory
 * changed; `bump` counts the change in `memory.revision` at once, for an observation made
 * outside a discovery sample, such as an interaction.
 */
export function observeGate(memory: DiscoveryMemory, gate: Pick<Gate, 'id' | 'open' | 'locked'>, bump = true): boolean {
  const gates = memory.gates ??= new Map(), seen: GateObservation | undefined = gates.get(gate.id);
  const locked = !!gate.locked;
  if (seen && seen.open === gate.open && seen.locked === locked) return false;
  gates.set(gate.id, { open: gate.open, locked });
  if (bump) memory.revision = (memory.revision ?? 0) + 1;
  return true;
}

/**
 * Reconstruct a player's discovery state by folding `discover` over recorded frames.
 * Gladiators have no discovery memory and return an empty set. `sight` is the core binding samples run through.
 */
export function foldDiscovery(
  sight: CoreSight,
  map: DiscoveryMap,
  frames: Iterable<{
    tick?: number;
    gates?: Array<Partial<Gate> & { gateIdx?: number }>;
    bodies?: Array<{ owner?: { kind: string; playerIdx?: number }; x: number; y: number }>;
    players: Array<{ id: PlayerId; playerIdx?: number; x?: World; y?: World; role?: Role; status?: string }>;
  }>,
  playerId: PlayerId,
  options?: { interval?: number; playerIndex?: number }
): DiscoveryMemory {
  const memory = createDiscovery();
  const converter = createFrameNormalizer(map);
  const interval = options?.interval ?? DISCOVERY_INTERVAL;

  for (const captured of frames) {
    const frame = converter.normalize(captured);
    const idx = frame.players.findIndex(player => player.id === playerId);
    if (idx === -1) continue;
    const p = frame.players[idx]!;
    if (p.role === 'gladiator') continue;
    if (p.status && p.status !== 'active') continue;

    const playerIndex = options?.playerIndex ?? idx;
    const shouldSample = frame.tick === undefined || frame.tick === 0 || (frame.tick + playerIndex) % interval === 0;
    if (!shouldSample) continue;

    const currentMap = { ...map, gates: frame.gates as Gate[] };
    if (p.x !== undefined && p.y !== undefined) discover(sight, memory, currentMap, { x: p.x, y: p.y });
  }

  return memory;
}

export interface EncodedDiscovery {
  k: number;
  all: () => DiscoveryWire;
  changes: DiscoveryWire;
}

const REKEY_FLOOR = 16;

/**
 * Server discovery encoder, one per contestant view key.
 * Measures newly added cells against the keyframe baseline.
 * Re-keys when the newly added cell count exceeds the rekey floor.
 */
export function createDiscoveryEncoder(rekeyFloor = REKEY_FLOOR) {
  let table: { k: number; all: number[]; set: Set<number> } | null = null;
  /** A new keyframe holding `list`: the whole set under a fresh version, and no changes. */
  const keyframe = (list: number[]): EncodedDiscovery => {
    const k = nextVersion(), all = list;
    table = { k, all, set: new Set(list) };
    return { k, all: () => ({ k, all }), changes: { k } };
  };

  return {
    encode(list: number[]): EncodedDiscovery {
      if (!table) return keyframe(list);

      const newlyAdded: number[] = [];
      for (const id of list) {
        if (!table.set.has(id)) newlyAdded.push(id);
      }

      if (list.length < table.set.size + newlyAdded.length || newlyAdded.length > rekeyFloor) {
        count('work.rekey.discovered');
        return keyframe(list);
      }

      const currentK = table.k;
      const currentAll = table.all;
      const changes: DiscoveryWire = newlyAdded.length > 0 ? { k: currentK, set: newlyAdded } : { k: currentK };
      const allWire = (): DiscoveryWire => (newlyAdded.length > 0 ? { k: currentK, all: currentAll, set: newlyAdded } : { k: currentK, all: currentAll });

      return {
        k: currentK,
        all: allWire,
        changes,
      };
    },
    reset(): void {
      table = null;
    },
  };
}

/** Client-side discovery decoder that accumulates keyframe and deltas into a known set. */
export function createDiscoveryDecoder() {
  let known = new Set<number>();
  let currentK = 0;
  return {
    decode(wire: DiscoveryWire | number[] | null | undefined): Set<number> {
      if (!wire) return known;
      if (Array.isArray(wire)) {
        known = new Set(wire);
        return known;
      }
      if (wire.all) {
        currentK = wire.k;
        known = new Set(wire.all);
        if (wire.set) {
          for (const idx of wire.set) known.add(idx);
        }
      } else if (wire.k === currentK && wire.set) {
        for (const idx of wire.set) known.add(idx);
      }
      return known;
    },
    get known(): Set<number> {
      return known;
    },
    isDiscovered(map: Pick<CollisionMap, 'width' | 'height'>, x: World, y: World): boolean {
      const idx = cellIndexAt(map, x, y);
      return idx !== -1 && known.has(idx);
    },
    reset(): void {
      known = new Set();
      currentK = 0;
    },
  };
}
