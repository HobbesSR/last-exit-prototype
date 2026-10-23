import { gateShape, insideMap, litPoint, visibilityPolygon } from './movement.ts';
import { MAX_VIEW_HEIGHT, MAX_VIEW_WIDTH, roofConceals } from './view.ts';
import { nextVersion } from './frame-layers.ts';
import type { CollisionMap, DiscoveryMemory, DiscoveryWire, GameMap, Gate, GateObservation, ItemId, Player, PlayerId, Role, Vec2, World } from './types.ts';
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
type DiscoveryMap = CollisionMap & Pick<GameMap, 'buildings'> & Partial<Pick<GameMap, 'items' | 'chargers' | 'stations' | 'exit'>>;

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
 * Sample discovery from an eye position against the map. Two rules, split by what is learned (Corey,
 * 2026-10-14, 15):
 * - **World geometry** is learned from the view window: every cell whose centre lies within the largest
 *   viewport a client may have is discovered, regardless of walls and roofs. Landmarks are discovered
 *   from their beacon radius. This is what the minimap draws.
 * - **Dynamic state** needs line of sight. With `observe` (bots, #230), one visibility polygon marks the
 *   cells whose centres are lit and not roof-concealed as `memory.seen`, which a bot searches against,
 *   and updates `memory.items`: items in sight are remembered, and a remembered item whose spot is seen
 *   empty is forgotten. Doors in sight are remembered as they stand (`memory.gates`), and every cell
 *   the view window covers is `memory.surveyed`, the layout navigation may treat as known (22.6).
 * Returns the newly discovered cell indices; `memory.revision` counts each sample that changed anything.
 */
export function discover(
  memory: DiscoveryMemory,
  map: DiscoveryMap,
  eye: Vec2,
  radius: World = DISCOVERY_RADIUS,
  observe = false
): number[] {
  const { cols, rows } = discoveryGrid(map);
  const newlyDiscovered: number[] = [];
  let changed = false;
  const mark = (idx: number) => { if (!memory.discovered.has(idx)) { memory.discovered.add(idx); newlyDiscovered.push(idx); } };
  const cells = (halfWidth: World, halfHeight: World, visit: (idx: number, cx: World, cy: World) => void, anyGround = false) => {
    const minCol = Math.max(0, Math.floor((eye.x - halfWidth) / DISCOVERY_CELL_SIZE));
    const maxCol = Math.min(cols - 1, Math.floor((eye.x + halfWidth) / DISCOVERY_CELL_SIZE));
    const minRow = Math.max(0, Math.floor((eye.y - halfHeight) / DISCOVERY_CELL_SIZE));
    const maxRow = Math.min(rows - 1, Math.floor((eye.y + halfHeight) / DISCOVERY_CELL_SIZE));
    for (let row = minRow; row <= maxRow; row++) for (let col = minCol; col <= maxCol; col++) {
      const cx = col * DISCOVERY_CELL_SIZE + DISCOVERY_CELL_SIZE / 2, cy = row * DISCOVERY_CELL_SIZE + DISCOVERY_CELL_SIZE / 2;
      if (Math.abs(cx - eye.x) <= halfWidth && Math.abs(cy - eye.y) <= halfHeight && (anyGround || insideMap(map, cx, cy))) visit(row * cols + col, cx, cy);
    }
  };

  cells(DISCOVERY_VIEW.halfWidth, DISCOVERY_VIEW.halfHeight, mark);
  if (observe) {
    const surveyed = memory.surveyed ??= new Set();
    cells(DISCOVERY_VIEW.halfWidth, DISCOVERY_VIEW.halfHeight, idx => { if (!surveyed.has(idx)) { surveyed.add(idx); changed = true; } }, true);
  }
  // A landmark's beacon shows over walls and roofs, so its cell is discovered from much further away.
  for (const landmark of landmarks(map)) {
    if ((landmark.x - eye.x) ** 2 + (landmark.y - eye.y) ** 2 > BEACON_RADIUS ** 2) continue;
    const idx = cellIndexAt(map, landmark.x, landmark.y);
    if (idx !== -1) mark(idx);
  }

  if (observe) {
    let poly: ReturnType<typeof visibilityPolygon> | null = null;
    const radiusSq = radius * radius;
    // The polygon is built only once something in reach needs it.
    const sees = (x: World, y: World): boolean => {
      if ((x - eye.x) ** 2 + (y - eye.y) ** 2 > radiusSq) return false;
      if (roofConceals(map, eye, { x, y })) return false;
      if (!poly) poly = visibilityPolygon(map, eye, radius);
      return litPoint(poly, eye, x, y);
    };
    const seen = memory.seen ??= new Set();
    cells(radius, radius, (idx, cx, cy) => { if (!seen.has(idx) && sees(cx, cy)) seen.add(idx); });
    if (map.items) {
      const items = memory.items ??= new Map();
      const present = new Set<ItemId>();
      for (const item of map.items) {
        if (!sees(item.x, item.y)) continue;
        present.add(item.id);
        items.set(item.id, { ...item });
      }
      for (const [id, item] of items) if (!present.has(id) && sees(item.x, item.y)) items.delete(id);
    }
    // A door is seen at the point of its outline nearest the eye, a unit toward the eye, so a closed door's own face does not hide it.
    for (const gate of map.gates) {
      const box = gateShape(gate);
      const nx = Math.max(box.x, Math.min(box.x + box.w, eye.x)), ny = Math.max(box.y, Math.min(box.y + box.h, eye.y));
      const dx = eye.x - nx, dy = eye.y - ny, d = Math.hypot(dx, dy);
      if (d <= radius && sees(d > 1 ? nx + dx / d : eye.x, d > 1 ? ny + dy / d : eye.y)) changed = observeGate(memory, gate, false) || changed;
    }
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
 * Gladiators have no discovery memory and return an empty set.
 */
export function foldDiscovery(
  map: DiscoveryMap,
  frames: Iterable<{
    tick?: number;
    gates?: Gate[];
    players: Array<{ id: PlayerId; x: World; y: World; role?: Role; status?: string }>;
  }>,
  playerId: PlayerId,
  options?: { interval?: number; playerIndex?: number }
): DiscoveryMemory {
  const memory = createDiscovery();
  const interval = options?.interval ?? DISCOVERY_INTERVAL;

  for (const frame of frames) {
    const idx = frame.players.findIndex(player => player.id === playerId);
    if (idx === -1) continue;
    const p = frame.players[idx]!;
    if (p.role === 'gladiator') continue;
    if (p.status && p.status !== 'active') continue;

    const playerIndex = options?.playerIndex ?? idx;
    const shouldSample = frame.tick === undefined || frame.tick === 0 || (frame.tick + playerIndex) % interval === 0;
    if (!shouldSample) continue;

    const currentMap = frame.gates ? { ...map, gates: frame.gates } : map;
    discover(memory, currentMap, p);
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

  return {
    encode(list: number[]): EncodedDiscovery {
      if (!table) {
        table = { k: nextVersion(), all: list, set: new Set(list) };
        return {
          k: table.k,
          all: () => ({ k: table!.k, all: table!.all }),
          changes: { k: table.k },
        };
      }

      const newlyAdded: number[] = [];
      for (const id of list) {
        if (!table.set.has(id)) newlyAdded.push(id);
      }

      if (list.length < table.set.size + newlyAdded.length || newlyAdded.length > rekeyFloor) {
        table = { k: nextVersion(), all: list, set: new Set(list) };
        return {
          k: table.k,
          all: () => ({ k: table!.k, all: table!.all }),
          changes: { k: table.k },
        };
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
