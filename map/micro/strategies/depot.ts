import { rect } from '../../../shared/shape.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { largestRectangle } from './hall.ts';
import { unfilledRegion, cellLoot, fraction, protectedRoutes } from './scatter.ts';
import { draw } from '../random.ts';
import { createFillMask, createRegionMask, elementShapes, shapesOverlap } from '../geometry.ts';
import { boxesAgainstHints, hintedCells } from '../hints.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import { WAREHOUSE } from '../placeables/warehouse.ts';
import { CONTAINER_ROW } from '../placeables/container-row.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import type { Placed } from '../placeables/placeable.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

/** The catalogue's proposed shape need (54): a contained square at least this many cells a side. */
const MIN_SIDE = 10;
/**
 * Clear cells between pieces, as `cover` keeps: a doorway (52), so a hunter fits each aisle.
 */
const AISLE = CELL_SCALE.doorway;
const DEFAULT_DENSITY = 0.55;
/** A warehouse's long side in cells. Its short side is three quarters of that, at least 5. */
const MIN_ROOM = 6, MAX_ROOM = 16, DEFAULT_ROOM = 8;
/** A container in a row is 2 cells long, and a row holds two or three. */
const CONTAINER = 2, ROW_MIN = 2, ROW_MAX = 3;
/** Cells from one lane to the next: a row a cell across, and an aisle. */
const LANE = 1 + AISLE;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { axis: 1, phase: 2, site: 3, row: 4, length: 5, loot: 6, design: 7 };

/**
 * The `depot` region type (54): warehouses and container rows on industrial ground, with long
 * sightlines down the aisles and hard corners at their ends. It has no decomposer.
 *
 * Everything lines up on lanes `LANE` cells apart along one axis, drawn from the seed.
 * Warehouses come first: roofed boxes `roomCells` long, at seeded places on the lanes until
 * about `density` of a quarter of the ground is spoken for. Each is a building design (56),
 * in a seeded order a floor with an office and a store, or a floor with an office, and one
 * room with a door at each end where neither fits (the `warehouse` placeable, 20.8). Shelf islands run down the
 * floor. Container rows follow, two or three containers end to end, packed along each lane
 * around the warehouses. Each place that fits one is taken with chance `density`.
 *
 * Every piece's box keeps `AISLE` clear cells from other pieces. Candidate footprints stay
 * owned and clear of portal approaches, and the builder protects a swept hunter route tree
 * between nearby portals, whatever their count (#347).
 * Hinted runs receive priority when a warehouse can fit against them. A region with no
 * contained `MIN_SIDE` square goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every wall, door, shelf and container, indoors or out. A depot sites no core elements; any
 * the brief lists are left for the report.
 *
 * `observe`, when given, sees each warehouse's design, allocation and realization, and the
 * designs passed over with why. The manifest's `designed` counts warehouses of several spaces.
 */
export function buildDepot(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const density = fraction(brief, 'Depot', 'density', DEFAULT_DENSITY);
  const room = brief.parameters?.roomCells ?? DEFAULT_ROOM;
  if (typeof room !== 'number' || !Number.isInteger(room) || room < MIN_ROOM || room > MAX_ROOM)
    throw new RangeError(`Depot roomCells must be a whole number of cells from ${MIN_ROOM} to ${MAX_ROOM}.`);
  const mask = createFillMask(brief), size = brief.cellSize;
  if (!mask.cells.length) return unfilledRegion(brief, CHANNEL.loot);
  if (!largestRectangle(mask, MIN_SIDE)) return unfilledRegion(brief, CHANNEL.loot);
  // Nearby portal routes are protected at any portal count. Boundary spacing alone let a
  // warehouse seal a portal's approach in large depots (#347), and the tree stays cheap.
  const protectedShapes = protectedRoutes(brief, 'Depot', 'nearby');


  // Lines run along u. `alongX` maps (u, v) to (x, y), or else to (y, x).
  const alongX = draw(brief.seed, 0, 0, CHANNEL.axis) < 0.5;
  const taken = new Set<string>();
  const cellAt = (u: number, v: number) => alongX ? `${u},${v}` : `${v},${u}`;
  const owns = (u: number, v: number) => alongX ? mask.has(u, v) : mask.has(v, u);
  // A box must be owned and clear of portal approaches; only other pieces need an aisle.
  const clear = (u: number, v: number, length: number, width: number) => {
    for (let j = v; j < v + width; j++) for (let i = u; i < u + length; i++)
      if (!owns(i, j)) return false;
    for (let j = v - AISLE; j < v + width + AISLE; j++) for (let i = u - AISLE; i < u + length + AISLE; i++)
      if (taken.has(cellAt(i, j))) return false;
    const [x, y, w, h] = alongX ? [u, v, length, width] : [v, u, width, length];
    return !protectedShapes.some(shape => shapesOverlap(rect(x * size, y * size, w * size, h * size), shape));
  };
  const take = (u: number, v: number, length: number, width: number) => {
    for (let j = v; j < v + width; j++) for (let i = u; i < u + length; i++) taken.add(cellAt(i, j));
  };
  const cells = [...mask.cells].map(c => alongX ? { u: c.x, v: c.y } : { u: c.y, v: c.x });

  const elements: RegionElement[] = [];
  const place = (label: string, u: number, v: number, placed: Placed<unknown>) => {
    const [x, y] = alongX ? [u, v] : [v, u];
    elements.push(...placedElements(placed, label, x, y, size));
  };

  // Lanes run along u, one every LANE cells across, at a seeded phase. Warehouses and rows both start on one.
  const firstHint = hintedCells(brief)[0];
  const hintedLane = firstHint && (alongX ? firstHint.y : firstHint.x);
  const phase = hintedLane === undefined ? Math.floor(draw(brief.seed, 0, 1, CHANNEL.phase) * LANE) : ((hintedLane % LANE) + LANE) % LANE;
  const onLane = (v: number) => ((v - phase) % LANE + LANE) % LANE === 0;

  // Warehouses, at seeded places on the lanes, in an order that doesn't depend on the brief's cell order.
  const across = Math.max(5, Math.round(room * 3 / 4));
  const target = Math.max(1, Math.round(density * cells.length / (4 * room * across)));
  let warehouses = 0, designed = 0;
  const hintedWarehouses = new Set(boxesAgainstHints(brief, alongX ? room : across, alongX ? across : room)
    .map(b => alongX ? `${b.x},${b.y}` : `${b.y},${b.x}`));
  if (density > 0) for (const { u, v } of cells.filter(c => onLane(c.v)).map(c => ({ ...c, order: draw(brief.seed, c.u, c.v, CHANNEL.site),
    hinted: hintedWarehouses.has(`${c.u},${c.v}`) }))
    .sort((a, b) => Number(b.hinted) - Number(a.hinted) || a.order - b.order || a.v - b.v || a.u - b.u)) {
    if (warehouses === target) break;
    if (!clear(u, v, room, across)) continue;
    take(u, v, room, across);
    const label = `depot-warehouse-${++warehouses}`;
    const seed = Math.floor(draw(brief.seed, u, v, CHANNEL.design) * 2 ** 31);
    const [x, y] = alongX ? [u, v] : [v, u];
    const built = expectPlaced(WAREHOUSE.build({ w: alongX ? room : across, h: alongX ? across : room, alongX, seed }, size));
    const { design, allocation, realization, rejected } = built.details;
    if (design.spaces.length > 1) designed++;
    observe?.({ label, origin: { x: x * size, y: y * size }, cellSize: size, design, allocation, realization, ...rejected.length ? { rejected } : {} });
    place(label, u, v, built);
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
        place(`depot-row-${++rows}`, u, v, expectPlaced(CONTAINER_ROW.build({ length, alongX }, size)));
      }
      u += length + AISLE;
    }
  }

  const parts = elements.flatMap(element => element.template.parts);
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: warehouses, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0, warehouses, designed, rows } };
}
