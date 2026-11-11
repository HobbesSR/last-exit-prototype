import { canOccupy } from '../movement.ts';
import { WORLD_WIDTH, WORLD_HEIGHT } from './world.ts';
import { distance } from '../vector.ts';
import { fieldsOf, rect as rectShape } from '../shape.ts';
import type { Shape } from '../shape.ts';
import type { Box, BuildingId, GroundItem, ItemKind, MapDraft, NodeId, Obstacle, ObstacleId, ObstacleKind, ItemId, Vec2, World } from '../types.ts';

export { distance };

/** A candidate loot position, tagged with the block and building it belongs to. */
export interface LootSpot extends Vec2 {
  nodeId?: NodeId | undefined;
  buildingId?: BuildingId | undefined;
}

/** What `createGenerationContext` provides: randomness, ids, and placement bookkeeping. */
export interface BaseGenerationContext {
  map: MapDraft;
  /** Seeded PRNG in [0, 1). The order of draws determines the arena. */
  random(): number;
  nextId(prefix: string): string;
  /** Emit world geometry of any form. `rect` is the shorthand for the common one. */
  shape(form: Shape, kind: ObstacleKind, extra?: Partial<Obstacle>): Obstacle;
  rect(x: World, y: World, w: World, h: World, kind: ObstacleKind, extra?: Partial<Obstacle>): Obstacle;
  reservations: Box[];
  spots: LootSpot[];
  /** Everything already placed, for separation tests. */
  occupied: Vec2[];
  place(x: World, y: World, kind: ItemKind, extra?: Partial<GroundItem>, separation?: World): GroundItem | null;
}

// One context owns all random draws, IDs, and placement bookkeeping for a generation.
export function createGenerationContext(seed: number): BaseGenerationContext {
  let rng = seed || 1;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const map: MapDraft = { seed, width: WORLD_WIDTH, height: WORLD_HEIGHT, modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [] };
  let serial = 0;
  const nextId = (prefix: string) => prefix + serial++;
  // Field order is part of the recorded map: the characterization fixture hashes the map's JSON.
  const shape = (form: Shape, kind: ObstacleKind, extra: Partial<Obstacle> = {}) => { const o: Obstacle = { id: nextId('o') as ObstacleId, ...fieldsOf(form), kind, ...extra }; map.obstacles.push(o); return o; };
  const rect = (x: World, y: World, w: World, h: World, kind: ObstacleKind, extra: Partial<Obstacle> = {}) => shape(rectShape(x, y, w, h), kind, extra);
  const reservations: Box[] = [];
  const spots: LootSpot[] = [];
  const occupied: Vec2[] = [];
  function place(x: World, y: World, kind: ItemKind, extra: Partial<GroundItem> = {}, separation: World = 55) {
    if (!canOccupy(map, x, y, 24) || occupied.some(p => distance(p, { x, y }) < separation)) return null;
    const item: GroundItem = { id: nextId('item-') as ItemId, x, y, kind, ...extra }; map.items.push(item); occupied.push(item); return item;
  }
  return { map, random, nextId, shape, rect, reservations, spots, occupied, place };
}
