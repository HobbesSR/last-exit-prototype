import { TILE } from '../movement.ts';
import { stepClear, tileWalkable } from '../map/navigation.ts';
import { nearestTile } from '../map/route.ts';
import type { CollisionMap, DoorPermission, Role, TileCount, TileIndex, TileRect, TileStep, Vec2, World } from '../types.ts';
import type { PortalGraph, Reach } from './portal-graph.ts';

/**
 * The interim bottom level (22.6): today's walkability grid, searched within one region instead
 * of a fixed box around the endpoints. One flood from a point measures its distance to every
 * target at once, which is what the portal graph needs from a region. The free-space
 * triangulation replaces it.
 */

/** How far past a region's cells a search may go: a portal's clear margin lies across it (20.6). */
const MARGIN: World = 96;
const DIAGONAL = Math.SQRT2 * TILE;
/** Region searches kept ready; a planner's construction visits each region once, in order. */
const KEEP = 64;

/** A route's length from `a` through its tile centres to `b`; never less than the straight line, by the triangle inequality. */
export function stepsLength(a: Vec2, steps: readonly TileStep[], b: Vec2): World {
  let length = 0, from = a;
  for (const [x, y] of steps) {
    const to = { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE };
    length += Math.hypot(to.x - from.x, to.y - from.y); from = to;
  }
  return length + Math.hypot(b.x - from.x, b.y - from.y);
}

/**
 * One region's searchable tiles: walkable tiles of its bounds whose centre lies within
 * `MARGIN` of a cell it owns, numbered compactly so a flood costs the region's area, not
 * its bounding box's.
 */
interface RegionTiles {
  bounds: TileRect;
  /** Bounds index to compact index, or -1 when the tile isn't searchable. */
  compact: Int32Array;
  /** Compact index to bounds index. */
  tiles: Int32Array;
  /** Each tile's eight moves as compact indices, -1 where closed: four orthogonal, then four diagonal. */
  moves: Int32Array;
  /** Snapped endpoints already resolved, by point. */
  snapped: Map<string, number>;
}

function regionTiles(map: CollisionMap, walkable: (x: number, y: number) => boolean, graph: PortalGraph, region: number): RegionTiles {
  const box = graph.regions[region]!.box;
  const x = Math.max(0, Math.floor((box.x - MARGIN) / TILE)), y = Math.max(0, Math.floor((box.y - MARGIN) / TILE));
  const bounds = { x: x as TileIndex, y: y as TileIndex,
    width: Math.min(Math.ceil((box.x + box.w + MARGIN) / TILE), Math.ceil(map.width / TILE)) - x as TileCount,
    height: Math.min(Math.ceil((box.y + box.h + MARGIN) / TILE), Math.ceil(map.height / TILE)) - y as TileCount };
  const { width, height } = bounds;
  const near = new Uint8Array(width * height), size = graph.cellSize;
  const firstCol = Math.floor(box.x / size), firstRow = Math.floor(box.y / size);
  for (let row = firstRow; row < firstRow + box.h / size; row++) for (let col = firstCol; col < firstCol + box.w / size; col++) {
    if (graph.owner[row * graph.cols + col] !== region) continue;
    const left = Math.max(0, Math.ceil((col * size - MARGIN) / TILE - 0.5) - x), right = Math.min(width - 1, Math.floor(((col + 1) * size + MARGIN) / TILE - 0.5) - x);
    const top = Math.max(0, Math.ceil((row * size - MARGIN) / TILE - 0.5) - y), bottom = Math.min(height - 1, Math.floor(((row + 1) * size + MARGIN) / TILE - 0.5) - y);
    for (let ty = top; ty <= bottom; ty++) near.fill(1, ty * width + left, ty * width + right + 1);
  }
  const compact = new Int32Array(width * height).fill(-1), tiles: number[] = [];
  for (let i = 0; i < near.length; i++) if (near[i] && walkable(i % width + x, Math.floor(i / width) + y)) compact[i] = tiles.push(i) - 1;
  // Each tile's moves, orthogonal first: a diagonal only where both sides of its corner are open.
  const open = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < width && ty < height && compact[ty * width + tx]! >= 0;
  const moves = new Int32Array(tiles.length * 8).fill(-1);
  tiles.forEach((at, i) => {
    const tx = at % width, ty = (at - tx) / width;
    MOVES.forEach(([dx, dy], m) => {
      if (open(tx + dx, ty + dy) && (!dx || !dy || open(tx + dx, ty) && open(tx, ty + dy))) moves[i * 8 + m] = compact[(ty + dy) * width + tx + dx]!;
    });
  });
  return { bounds, compact, tiles: Int32Array.from(tiles), moves, snapped: new Map() };
}
const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const;

/**
 * Distances over the grid for one body, with the door permission today's planner uses. Moves
 * are the eight neighbours `gridRoute`'s finder takes, a diagonal only where both sides of its
 * corner are walkable, so the two agree on what connects, here within the region's tiles.
 */
export function gridReach(map: CollisionMap, role: Role, graph: PortalGraph, openDoors: DoorPermission = true): Reach {
  const ready = new Map<number, RegionTiles>(), walkable = tileWalkable(map, role, openDoors);
  const tilesOf = (region: number): RegionTiles => {
    let found = ready.get(region);
    if (found) return found;
    found = regionTiles(map, walkable, graph, region);
    if (ready.size >= KEEP) ready.delete(ready.keys().next().value!);
    ready.set(region, found);
    return found;
  };
  return (from, targets, region) => {
    const area = tilesOf(region), { bounds } = area, width = bounds.width;
    const centre = (i: number) => ({ x: (i % width + bounds.x + 0.5) * TILE, y: (Math.floor(i / width) + bounds.y + 0.5) * TILE });
    const tileOf = (point: Vec2): number => {
      const key = `${point.x},${point.y}`;
      let index = area.snapped.get(key);
      if (index === undefined) {
        // `gridRoute`'s snapping, over the region's tiles: so the two agree on where an endpoint starts.
        const inside = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < width && ty < bounds.height && area.compact[ty * width + tx]! >= 0;
        const local = { x: point.x - bounds.x * TILE, y: point.y - bounds.y * TILE };
        const t = nearestTile(inside, local, c => stepClear(map, openDoors, point, { x: c.x + bounds.x * TILE, y: c.y + bounds.y * TILE }));
        index = inside(t.x, t.y) ? area.compact[t.y * width + t.x]! : -1;
        area.snapped.set(key, index);
      }
      return index;
    };
    const source = tileOf(from);
    if (source < 0) return targets.map(() => null);
    const ends = targets.map(tileOf);
    const distance = flood(area, source, ends.filter(tile => tile >= 0));
    const start = centre(area.tiles[source]!), lead = Math.hypot(start.x - from.x, start.y - from.y);
    return targets.map((target, i) => {
      const tile = ends[i]!;
      if (tile < 0 || distance[tile] === Infinity) return null;
      // Through tile centres, as `stepsLength` counts a route; the same tile is the straight line.
      if (tile === source) return Math.hypot(target.x - from.x, target.y - from.y);
      const end = centre(area.tiles[tile]!);
      return lead + distance[tile]! + Math.hypot(target.x - end.x, target.y - end.y);
    });
  };
}

/**
 * Dijkstra from one compact tile over a region's tiles, stopping once every target is settled:
 * the targets' distances between centres are final, Infinity where unreachable. Other tiles'
 * entries are only bounds.
 */
function flood(area: RegionTiles, source: number, targets: readonly number[]): Float64Array {
  const { tiles, moves } = area;
  const distance = new Float64Array(tiles.length).fill(Infinity);
  const heap = new TileHeap(tiles.length);
  const wanted = new Uint8Array(tiles.length);
  let pending = 0;
  for (const tile of targets) if (!wanted[tile]) { wanted[tile] = 1; pending++; }
  distance[source] = 0; heap.push(source, 0);
  while (heap.size && pending) {
    const tile = heap.pop(), d = distance[tile]!;
    if (heap.lastKey > d) continue;
    if (wanted[tile]) { wanted[tile] = 0; pending--; }
    for (let m = 0, base = tile * 8; m < 8; m++) {
      const next = moves[base + m]!;
      if (next < 0) continue;
      const nd = d + (m < 4 ? TILE : DIAGONAL);
      if (nd < distance[next]!) { distance[next] = nd; heap.push(next, nd); }
    }
  }
  return distance;
}

/** A binary min-heap of tile indices by key; equal keys pop the lower index first, so floods are deterministic. */
class TileHeap {
  private tiles: Int32Array;
  private keys: Float64Array;
  size = 0;
  lastKey = 0;
  constructor(capacity: number) { this.tiles = new Int32Array(Math.max(16, capacity)); this.keys = new Float64Array(this.tiles.length); }
  private less(i: number, j: number): boolean { return this.keys[i]! < this.keys[j]! || this.keys[i] === this.keys[j] && this.tiles[i]! < this.tiles[j]!; }
  private swap(i: number, j: number): void {
    const t = this.tiles[i]!, k = this.keys[i]!;
    this.tiles[i] = this.tiles[j]!; this.keys[i] = this.keys[j]!; this.tiles[j] = t; this.keys[j] = k;
  }
  push(tile: number, key: number): void {
    if (this.size === this.tiles.length) {
      const tiles = new Int32Array(this.size * 2), keys = new Float64Array(this.size * 2);
      tiles.set(this.tiles); keys.set(this.keys); this.tiles = tiles; this.keys = keys;
    }
    let i = this.size++;
    this.tiles[i] = tile; this.keys[i] = key;
    while (i > 0) { const up = (i - 1) >> 1; if (!this.less(i, up)) break; this.swap(i, up); i = up; }
  }
  pop(): number {
    const top = this.tiles[0]!; this.lastKey = this.keys[0]!;
    if (--this.size > 0) {
      this.tiles[0] = this.tiles[this.size]!; this.keys[0] = this.keys[this.size]!;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}
