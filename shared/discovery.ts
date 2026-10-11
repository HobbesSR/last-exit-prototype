import { insideMap, litPoint, visibilityPolygon } from './movement.ts';
import { roofConceals } from './view.ts';
import { nextVersion } from './frame-layers.ts';
import type { CollisionMap, DiscoveryMemory, DiscoveryWire, GameMap, Gate, Player, PlayerId, Role, Vec2, World } from './types.ts';
export type { DiscoveryMemory, DiscoveryWire };

/** The side length of a coarse discovery cell in world units (4 x 48 map cells). */
export const DISCOVERY_CELL_SIZE: World = 192;
/** The viewport-sized sight radius used for contestant discovery (reach of the fog). */
export const DISCOVERY_RADIUS: World = 1200;
/** How often a contestant samples discovery, staggered per player. */
export const DISCOVERY_INTERVAL = 10;

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
 * Sample discovery from an eye position against the map.
 * Builds one visibility polygon and marks grid cells whose centres pass litPoint and are not roof-concealed.
 * Returns the newly discovered cell indices.
 */
export function discover(
  memory: DiscoveryMemory,
  map: CollisionMap & Pick<GameMap, 'buildings'>,
  eye: Vec2,
  radius: World = DISCOVERY_RADIUS
): number[] {
  const { cols, rows } = discoveryGrid(map);

  const minCol = Math.max(0, Math.floor((eye.x - radius) / DISCOVERY_CELL_SIZE));
  const maxCol = Math.min(cols - 1, Math.floor((eye.x + radius) / DISCOVERY_CELL_SIZE));
  const minRow = Math.max(0, Math.floor((eye.y - radius) / DISCOVERY_CELL_SIZE));
  const maxRow = Math.min(rows - 1, Math.floor((eye.y + radius) / DISCOVERY_CELL_SIZE));

  let poly: ReturnType<typeof visibilityPolygon> | null = null;
  const newlyDiscovered: number[] = [];
  const radiusSq = radius * radius;

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const idx = row * cols + col;
      if (memory.discovered.has(idx)) continue;

      const cx = col * DISCOVERY_CELL_SIZE + DISCOVERY_CELL_SIZE / 2;
      const cy = row * DISCOVERY_CELL_SIZE + DISCOVERY_CELL_SIZE / 2;

      const distSq = (cx - eye.x) ** 2 + (cy - eye.y) ** 2;
      if (distSq > radiusSq) continue;
      if (!insideMap(map, cx, cy)) continue;
      if (roofConceals(map, eye, { x: cx, y: cy })) continue;

      if (!poly) poly = visibilityPolygon(map, eye, radius);
      if (!litPoint(poly, eye, cx, cy)) continue;

      memory.discovered.add(idx);
      newlyDiscovered.push(idx);
    }
  }

  return newlyDiscovered;
}

/**
 * Reconstruct a player's discovery state by folding `discover` over recorded frames.
 * Gladiators have no discovery memory and return an empty set.
 */
export function foldDiscovery(
  map: CollisionMap & Pick<GameMap, 'buildings'>,
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
