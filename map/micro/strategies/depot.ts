import { rect } from '../../../shared/shape.ts';
import { buildOpen } from './open.ts';
import { largestRectangle } from './hall.ts';
import { cellLoot, draw, fraction } from './scatter.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

/** The catalogue's proposed shape need (54): a contained square at least this many cells a side. */
const MIN_SIDE = 10;
/**
 * Clear cells around every piece's box, from every other piece and from any cell the region
 * doesn't own, as `cover` keeps: a doorway (52), so a hunter fits each aisle.
 */
const AISLE = CELL_SCALE.doorway;
const DEFAULT_DENSITY = 0.55;
/** A warehouse's long side in cells. Its short side is three quarters of that, at least 5. */
const MIN_ROOM = 6, MAX_ROOM = 16, DEFAULT_ROOM = 8;
/** Wall thickness, in cells, as `hut`'s are. */
const WALL = 0.25;
/** Cells across a shelf island, and how far its container stands inside them. */
const SHELF_INSET = 0.2;
/** A container in a row is 2 cells long, and a row holds two or three. */
const CONTAINER = 2, ROW_MIN = 2, ROW_MAX = 3;
/** Cells from one lane to the next: a row a cell across, and an aisle. */
const LANE = 1 + AISLE;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { axis: 1, phase: 2, site: 3, row: 4, length: 5, loot: 6 };

/**
 * The `depot` region type (54): warehouses and container rows on industrial ground, with long
 * sightlines down the aisles and hard corners at their ends. It has no decomposer.
 *
 * Everything lines up on lanes `LANE` cells apart along one axis, drawn from the seed.
 * Warehouses come first: roofed boxes `roomCells` long, with a doorway-wide door at each end
 * and shelf islands down their length, at seeded places on the lanes until about `density` of
 * a quarter of the ground is spoken for. Container rows follow, two or three containers end to
 * end, packed along each lane around the warehouses. Each place that fits one is taken with
 * chance `density`.
 *
 * Every piece's box keeps `AISLE` clear cells from every other piece's and from any cell the
 * region doesn't own, so no route search is needed. Each box is convex with a clear ring wider
 * than a hunter around it, and such boxes can't divide the ground a hunter can reach outside
 * them, where every portal is. So, like `cover`, the region keeps the portal promise exactly
 * when its shape does. A region with no contained `MIN_SIDE` square goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every wall, door, shelf and container, indoors or out. A depot sites no core elements; any
 * the brief lists are left for the report.
 */
export function buildDepot(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Depot', 'density', DEFAULT_DENSITY);
  const room = brief.parameters?.roomCells ?? DEFAULT_ROOM;
  if (typeof room !== 'number' || !Number.isInteger(room) || room < MIN_ROOM || room > MAX_ROOM)
    throw new RangeError(`Depot roomCells must be a whole number of cells from ${MIN_ROOM} to ${MAX_ROOM}.`);
  const mask = createRegionMask(brief), size = brief.cellSize;
  if (!largestRectangle(mask, MIN_SIDE)) return buildOpen(brief);

  // Lines run along u. `alongX` maps (u, v) to (x, y), or else to (y, x).
  const alongX = draw(brief.seed, 0, 0, CHANNEL.axis) < 0.5;
  const taken = new Set<string>();
  const cellAt = (u: number, v: number) => alongX ? `${u},${v}` : `${v},${u}`;
  const owns = (u: number, v: number) => alongX ? mask.has(u, v) : mask.has(v, u);
  // A box of `length` along u and `width` across, its ring of AISLE cells owned and untaken.
  const clear = (u: number, v: number, length: number, width: number) => {
    for (let j = v - AISLE; j < v + width + AISLE; j++) for (let i = u - AISLE; i < u + length + AISLE; i++)
      if (!owns(i, j) || taken.has(cellAt(i, j))) return false;
    return true;
  };
  const take = (u: number, v: number, length: number, width: number) => {
    for (let j = v; j < v + width; j++) for (let i = u; i < u + length; i++) taken.add(cellAt(i, j));
  };
  const cells = [...mask.cells].map(c => alongX ? { u: c.x, v: c.y } : { u: c.y, v: c.x });

  const elements: RegionElement[] = [];
  const place = (label: string, u: number, v: number, length: number, width: number, template: (w: number, h: number) => ElementTemplate) => {
    const [x, y] = alongX ? [u, v] : [v, u];
    elements.push({ label, x: x * size, y: y * size, template: template(...(alongX ? [length, width] : [width, length]) as [number, number]) });
  };

  // Lanes run along u, one every LANE cells across, at a seeded phase. Warehouses and rows both start on one.
  const phase = Math.floor(draw(brief.seed, 0, 1, CHANNEL.phase) * LANE);
  const onLane = (v: number) => ((v - phase) % LANE + LANE) % LANE === 0;

  // Warehouses, at seeded places on the lanes, in an order that doesn't depend on the brief's cell order.
  const across = Math.max(5, Math.round(room * 3 / 4));
  const target = Math.max(1, Math.round(density * cells.length / (4 * room * across)));
  let warehouses = 0;
  if (density > 0) for (const { u, v } of cells.filter(c => onLane(c.v)).map(c => ({ ...c, order: draw(brief.seed, c.u, c.v, CHANNEL.site) }))
    .sort((a, b) => a.order - b.order || a.v - b.v || a.u - b.u)) {
    if (warehouses === target) break;
    if (!clear(u, v, room, across)) continue;
    take(u, v, room, across);
    place(`depot-warehouse-${++warehouses}`, u, v, room, across, (w, h) => warehouse(size, w, h, alongX));
  }

  // Container rows packed along each lane, from its near end, around the warehouses. Each place
  // that fits a row is taken with chance `density`, and either way the next starts an aisle on.
  let rows = 0;
  const lanes = new Map<number, number[]>();
  for (const { u, v } of cells) if (onLane(v)) lanes.get(v)?.push(u) ?? lanes.set(v, [u]);
  for (const v of [...lanes.keys()].sort((a, b) => a - b)) {
    const us = lanes.get(v)!.sort((a, b) => a - b), last = us[us.length - 1]!;
    for (let u = us[0]!; u <= last;) {
      const length = CONTAINER * (ROW_MIN + Math.floor(draw(brief.seed, u, v, CHANNEL.length) * (ROW_MAX - ROW_MIN + 1)));
      if (!clear(u, v, length, 1)) { u++; continue; }
      if (draw(brief.seed, u, v, CHANNEL.row) < density) {
        take(u, v, length, 1);
        place(`depot-row-${++rows}`, u, v, length, 1, (w, h) => containerRow(size, w, h, alongX));
      }
      u += length + AISLE;
    }
  }

  const parts = elements.flatMap(element => element.template.parts);
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, mask, pieces, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: warehouses, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0, warehouses, rows } };
}

/** Maps a local (u, v) box in cells to a world-unit rect in the template's frame. */
const oriented = (size: number, alongX: boolean) => (u: number, v: number, length: number, width: number): Shape =>
  alongX ? rect(u * size, v * size, length * size, width * size) : rect(v * size, u * size, width * size, length * size);

/**
 * A warehouse `w` × `h` cells, its long side along u: walls on its box's edge, a doorway-wide
 * door centred on each end, and shelf islands a cell across down its length. Each island keeps
 * 2 cells from the long walls and the end walls, and from the next island, so every aisle is
 * open to a contestant and the doors open onto the clear ends. It encloses, so it has a roof.
 */
function warehouse(size: number, w: number, h: number, alongX: boolean): ElementTemplate {
  const [length, width] = alongX ? [w, h] : [h, w], box = oriented(size, alongX);
  const door0 = (width - CELL_SCALE.doorway) / 2, door1 = (width + CELL_SCALE.doorway) / 2;
  const parts: ElementTemplate['parts'] = [
    { part: 'obstacle', shape: box(0, 0, length, WALL), kind: 'building' },
    { part: 'obstacle', shape: box(0, width - WALL, length, WALL), kind: 'building' },
  ];
  for (const u of [0, length - WALL]) {
    parts.push({ part: 'obstacle', shape: box(u, WALL, WALL, door0 - WALL), kind: 'building' });
    parts.push({ part: 'obstacle', shape: box(u, door1, WALL, width - WALL - door1), kind: 'building' });
    const [gu, gv] = [u + WALL / 2, width / 2];
    parts.push(alongX ? { part: 'gate', x: gu * size, y: gv * size, w: WALL * size, h: CELL_SCALE.doorway * size }
      : { part: 'gate', x: gv * size, y: gu * size, w: CELL_SCALE.doorway * size, h: WALL * size });
  }
  for (let k = 2; k + 3 <= width; k += 3)
    parts.push({ part: 'obstacle', shape: box(2, k + SHELF_INSET, length - 4, 1 - 2 * SHELF_INSET), kind: 'container' });
  return { w: w * size, h: h * size, encloses: true, parts };
}

/** A row of containers end to end, `w` × `h` cells with its length along u, each a little inside its 2 cells. */
function containerRow(size: number, w: number, h: number, alongX: boolean): ElementTemplate {
  const length = alongX ? w : h, box = oriented(size, alongX), parts: ElementTemplate['parts'] = [];
  for (let u = 0; u < length; u += CONTAINER)
    parts.push({ part: 'obstacle', shape: box(u + 0.05, 0.05, CONTAINER - 0.1, 0.9), kind: 'container' });
  return { w: w * size, h: h * size, parts };
}
