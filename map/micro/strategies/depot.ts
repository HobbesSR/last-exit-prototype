import { rect } from '../../../shared/shape.ts';
import { allocateBuilding } from '../building/allocation.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingRealization } from '../building/realize.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign, BuildingSide } from '../building/design.ts';
import type { BuildingObserver } from '../building/trace.ts';
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
const CHANNEL = { axis: 1, phase: 2, site: 3, row: 4, length: 5, loot: 6, design: 7 };

/**
 * The `depot` region type (54): warehouses and container rows on industrial ground, with long
 * sightlines down the aisles and hard corners at their ends. It has no decomposer.
 *
 * Everything lines up on lanes `LANE` cells apart along one axis, drawn from the seed.
 * Warehouses come first: roofed boxes `roomCells` long, at seeded places on the lanes until
 * about `density` of a quarter of the ground is spoken for. Each is a building design (56),
 * in a seeded order a floor with an office and a store, or a floor with an office, and one
 * room with a door at each end where neither fits (`warehouse`). Shelf islands run down the
 * floor. Container rows follow, two or three containers end to end, packed along each lane
 * around the warehouses. Each place that fits one is taken with chance `density`.
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
 *
 * `observe`, when given, sees each warehouse's design, allocation and realization, and the
 * designs passed over with why. The manifest's `designed` counts warehouses of several spaces.
 */
export function buildDepot(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
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
  let warehouses = 0, designed = 0;
  if (density > 0) for (const { u, v } of cells.filter(c => onLane(c.v)).map(c => ({ ...c, order: draw(brief.seed, c.u, c.v, CHANNEL.site) }))
    .sort((a, b) => a.order - b.order || a.v - b.v || a.u - b.u)) {
    if (warehouses === target) break;
    if (!clear(u, v, room, across)) continue;
    take(u, v, room, across);
    const label = `depot-warehouse-${++warehouses}`;
    const seed = Math.floor(draw(brief.seed, u, v, CHANNEL.design) * 2 ** 31);
    place(label, u, v, room, across, (w, h) => {
      const { design, allocation, realization, template, rejected } = warehouse(size, w, h, alongX, seed);
      if (design.spaces.length > 1) designed++;
      const [x, y] = alongX ? [u, v] : [v, u];
      observe?.({ label, origin: { x: x * size, y: y * size }, cellSize: size, design, allocation, realization, ...rejected.length ? { rejected } : {} });
      return template;
    });
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
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0, warehouses, designed, rows } };
}

/** Maps a local (u, v) box in cells to a world-unit rect in the template's frame. */
const oriented = (size: number, alongX: boolean) => (u: number, v: number, length: number, width: number): Shape =>
  alongX ? rect(u * size, v * size, length * size, width * size) : rect(v * size, u * size, width * size, length * size);

/**
 * Shelf islands a cell across down a floor `length` cells along u from `u0`, spanning v from
 * `v0` to `v1`. Each island keeps 2 cells from the floor's walls and from the next island, so
 * every aisle is open to a contestant and the doors open onto clear ends. A floor shorter than
 * 5 cells has none.
 */
function shelves(size: number, alongX: boolean, u0: number, length: number, v0: number, v1: number): ElementTemplate['parts'] {
  const box = oriented(size, alongX), parts: ElementTemplate['parts'] = [];
  if (length < 5) return parts;
  for (let k = v0 + 2; k + 3 <= v1; k += 3)
    parts.push({ part: 'obstacle', shape: box(u0 + 2, k + SHELF_INSET, length - 4, 1 - 2 * SHELF_INSET), kind: 'container' });
  return parts;
}

type Design = ReadonlyArray<{ id: string; share: readonly [number, number] }>;
/**
 * The warehouse designs with several spaces, with each space's share of the box (56). The
 * floor takes at least half; an office and a store, each at least 3 × 3, take the rest.
 * Labels and shares are guidance (17.2.8 M28).
 */
const DESIGNS: ReadonlyArray<Design> = [
  [{ id: 'floor', share: [0.5, 1] }, { id: 'office', share: [0, 0.25] }, { id: 'store', share: [0, 0.25] }],
  [{ id: 'floor', share: [0.5, 1] }, { id: 'office', share: [0, 0.4] }],
];
/** The last resort: the whole box is the floor, with a door centred on each end. */
const ONE_ROOM: Design = [{ id: 'floor', share: [1, 1] }];

export type Warehouse = { design: BuildingDesign; allocation: BuildingAllocation; realization: BuildingRealization;
  template: ElementTemplate; rejected: { design: string; reason: string }[] };

/**
 * A warehouse `w` × `h` cells from the first design that fits: the designs with several spaces
 * in a seeded order, then one room. The floor is asked for a door on each end; the office for
 * a door into the floor, a door out on the far end, where it can front the warehouse, and a
 * window; the store for a door into the floor. A design is kept only if at least two doors
 * lead outside, so the warehouse stays a way through, and every space is reached through a
 * door from outside. Each design passed over is named in `rejected` with why. Missed openings
 * are guidance and stay as misses (M29). Shelves stand on the floor. `plant` builds its shed
 * with it too.
 */
export function warehouse(size: number, w: number, h: number, alongX: boolean, seed: number): Warehouse {
  const area = w * h, cells = Array.from({ length: area }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
  const ends: readonly BuildingSide[] = alongX ? ['W', 'E'] : ['N', 'S'];
  const rejected: Warehouse['rejected'] = [];
  for (const spaces of [...seed % 2 ? [...DESIGNS].reverse() : DESIGNS, ONE_ROOM]) {
    const ids = spaces.map(space => space.id), name = ids.join('+');
    const reject = (reason: string) => { rejected.push({ design: name, reason }); };
    const asked: BuildingDesign = {
      spaces: spaces.map(({ id, share: [min, max] }) => ({ id, area: { min: Math.max(9, Math.ceil(min * area)), max: Math.floor(max * area) },
        outside: 'prefer' as const, tags: [id] })),
      connections: [
        ...ends.map((side, i) => ({ id: `door-${i + 1}`, a: 'floor', b: OUTSIDE, kind: 'door' as const, side })),
        ...ids.slice(1).map(id => ({ id: `${id}-door`, a: 'floor', b: id, kind: 'door' as const })),
        ...ids.includes('office') ? [
          { id: 'office-entrance', a: 'office', b: OUTSIDE, kind: 'door' as const, side: ends[1] },
          { id: 'office-window', a: 'office', b: OUTSIDE, kind: 'window' as const },
        ] : [],
      ],
    };
    const allocated = allocateBuilding(asked, cells, { seed });
    if (!allocated.ok) { reject(allocated.reason); continue; }
    const { design, allocation } = allocated;
    const realization = realizeBuilding(design, allocation, { cellSize: size, thickness: WALL, encloses: true, corners: 'horizontal' });
    if (!realization.template || realization.issues.length) { reject(realization.issues.join(' ') || 'it could not be realized'); continue; }
    const exits = realization.openings.filter(({ kind, a, b }) => kind === 'door' && (a === OUTSIDE || b === OUTSIDE));
    if (exits.length < 2) { reject(`${exits.length} door${exits.length === 1 ? '' : 's'} out, fewer than two`); continue; }
    const reached = new Set([OUTSIDE]);
    for (let grown = true; grown;) {
      grown = false;
      for (const { kind, a, b } of realization.openings) {
        if (kind === 'window' || reached.has(a) === reached.has(b)) continue;
        reached.add(a); reached.add(b); grown = true;
      }
    }
    const unreached = ids.filter(id => !reached.has(id));
    if (unreached.length) { reject(`no door reaches ${unreached.join(', ')}`); continue; }
    const floor = allocation.spaces.find(space => space.id === 'floor')!.cells;
    const us = floor.map(c => alongX ? c.x : c.y), vs = floor.map(c => alongX ? c.y : c.x), u0 = Math.min(...us);
    const template = { ...realization.template, parts: [...realization.template.parts,
      ...shelves(size, alongX, u0, Math.max(...us) + 1 - u0, Math.min(...vs), Math.max(...vs) + 1)] };
    return { design, allocation, realization, template, rejected };
  }
  // One room with a door on each end always fits a box at least 5 cells a side. A miss here is a defect, not a new fallback.
  throw new Error(`A ${w} × ${h} warehouse could not be built as one room: ${rejected.at(-1)?.reason}`);
}

/** A row of containers end to end, `w` × `h` cells with its length along u, each a little inside its 2 cells. */
function containerRow(size: number, w: number, h: number, alongX: boolean): ElementTemplate {
  const length = alongX ? w : h, box = oriented(size, alongX), parts: ElementTemplate['parts'] = [];
  for (let u = 0; u < length; u += CONTAINER)
    parts.push({ part: 'obstacle', shape: box(u + 0.05, 0.05, CONTAINER - 0.1, 0.9), kind: 'container' });
  return { w: w * size, h: h * size, parts };
}
