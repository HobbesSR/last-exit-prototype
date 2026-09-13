import { canOccupy, insideMap } from '../movement.ts';
import { WORLD_WIDTH, WORLD_HEIGHT } from './world.ts';
import type { Box, BuildingId, GameMap, GroundItem, ItemKind, MapDraft, MapNode, NodeId, Obstacle, ObstacleId, ObstacleKind, ItemId, Vec2, World } from '../types.ts';

export const distance = (a: Vec2, b: Vec2): World => Math.hypot(a.x - b.x, a.y - b.y);

/** A candidate loot position, tagged with the block and building it belongs to. */
export interface LootSpot extends Vec2 {
  nodeId?: NodeId | undefined;
  buildingId?: BuildingId | undefined;
}

/** What `createGenerationContext` provides: randomness, ids, and placement bookkeeping. */
export interface BaseGenerationContext {
  map: MapDraft;
  /** Seeded PRNG in [0, 1). Stage order determines the draw order, and so the arena. */
  random(): number;
  range(a: number, b: number): number;
  nextId(prefix: string): string;
  rect(x: World, y: World, w: World, h: World, kind: ObstacleKind, extra?: Partial<Obstacle>): Obstacle;
  reservations: Box[];
  reserve(x: World, y: World, radius: World): void;
  clearFootprint(box: Box): boolean;
  spots: LootSpot[];
  /** Everything already placed, for separation tests. */
  occupied: Vec2[];
  place(x: World, y: World, kind: ItemKind, extra?: Partial<GroundItem>, separation?: World): GroundItem | null;
}

/** What `buildTopology` adds once the street graph exists. */
export interface TopologyContext {
  lookup: Map<NodeId, MapNode>;
  entryNode: MapNode;
  exitNode: MapNode;
  /** The main entry-to-exit block route. */
  main: MapNode[];
  edgeKey(a: MapNode, b: MapNode): string;
  /** Offset doorways, keyed by `edgeKey`. */
  ports: Map<string, Vec2>;
}

export interface GenerationContext extends BaseGenerationContext, TopologyContext {
  map: MapDraft & Pick<GameMap, 'entry' | 'exit'>;
}

/** A context whose map has spawn points, which `buildStructures` establishes. */
export interface SpawnedGenerationContext extends GenerationContext {
  map: MapDraft & Pick<GameMap, 'entry' | 'exit' | 'spawns'>;
}

// One context owns all random draws, IDs, and placement bookkeeping for a generation.
export function createGenerationContext(seed: number): BaseGenerationContext {
  let rng = seed || 1;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const range = (a: number, b: number) => Math.round(a + random() * (b - a));
  const map: MapDraft = { seed, width: WORLD_WIDTH, height: WORLD_HEIGHT, modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [] };
  let serial = 0;
  const nextId = (prefix: string) => prefix + serial++;
  const rect = (x: World, y: World, w: World, h: World, kind: ObstacleKind, extra: Partial<Obstacle> = {}) => { const o: Obstacle = { id: nextId('o') as ObstacleId, x, y, w, h, kind, ...extra }; map.obstacles.push(o); return o; };
  const overlaps = (a: Box, b: Box, margin = 0) => a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
  const reservations: Box[] = [];
  const reserve = (x: World, y: World, radius: World) => { reservations.push({ x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 }); };
  const clearFootprint = (box: Box) => insideMap(map, box.x + box.w / 2, box.y + box.h / 2, Math.hypot(box.w, box.h) / 2)
    && !map.obstacles.some(o => overlaps(box, o, 20)) && !reservations.some(r => overlaps(box, r, 10));
  const spots: LootSpot[] = [];
  const occupied: Vec2[] = [];
  function place(x: World, y: World, kind: ItemKind, extra: Partial<GroundItem> = {}, separation: World = 55) {
    if (!canOccupy(map, x, y, 24) || occupied.some(p => distance(p, { x, y }) < separation)) return null;
    const item: GroundItem = { id: nextId('item-') as ItemId, x, y, kind, ...extra }; map.items.push(item); occupied.push(item); return item;
  }
  return { map, random, range, nextId, rect, reservations, reserve, clearFootprint, spots, occupied, place };
}
