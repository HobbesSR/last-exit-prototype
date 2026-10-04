import { circle } from '../../../shared/shape.ts';
import { rng } from '../index.ts';
import { createRegionMask, elementShapes, shapesOverlap } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { portalStands } from '../portals.ts';
import { allocateBuilding } from '../building/allocation.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingRealization } from '../building/realize.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign } from '../building/design.ts';
import { buildOpen } from './open.ts';
import type { BuildingObserver } from '../building/trace.ts';
import type { BuiltRegion, LootSite, RegionBrief } from '../types.ts';

/** The one-space house's box in cells (54, proposed). */
const BOX = 4;
/** The clear cells a region needs beyond a box's extent on each axis: 6 for the 4 × 4 (54, proposed). Less goes to a smaller design or to `open`. */
const MARGIN = 2;
/** Wall thickness, in cells. */
const WALL = 0.25;
/** A hunter fits a 2 × 2 block of cells, and moving it by one cell sweeps a 2 × 3 rectangle. */
const BODY = 2;
/**
 * The larger designs, tried before the one-space house, largest first (54 `hut`, 56 L5). Each
 * names its spaces and the boxes it may take, in cells. Rooms are at least 3 × 3 (56).
 */
const LARGER: ReadonlyArray<{ spaces: number; boxes: ReadonlyArray<readonly [number, number]> }> = [
  { spaces: 3, boxes: [[6, 6], [8, 6], [6, 8], [9, 4], [4, 9]] },
  { spaces: 2, boxes: [[6, 4], [4, 6], [7, 5], [5, 7]] },
];

type Side = 'N' | 'E' | 'S' | 'W';
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };
type Built = { design: BuildingDesign; allocation: BuildingAllocation; realization: BuildingRealization };
/** A box's house with its door on one side, and where along that side the door's doorstep blocks start, in cells. */
type House = Built & { steps: number[] };

/**
 * The `hut` region type (54): one small building in its yard, with no decomposer.
 *
 * The builder works in cells, where a hunter is a 2 × 2 block of yard cells. It tries designs
 * largest first: three spaces, then two, then the one-space house in a 4 × 4 box. Each design
 * tries its boxes, and a region at least `MARGIN` cells wider and taller than the box, in a
 * seeded order. It takes the first contained box that:
 * - stays off every portal's approach, the two cells inward along it, where its hunter stands are
 * - leaves every two portals that the empty region joined still joined through the yard
 * - has a side whose doorstep, the 2 × 2 blocks outside the door, the yard joins to a portal.
 *
 * A larger design's spaces are allocated in its box (`allocateBuilding`), joined by interior
 * doors, with one door outside and windows as guidance. A design whose door or interior doors
 * miss on a side doesn't take that side. The house stands in the box with walls and a roof.
 * It has one door outside, so no route runs through it, and every space is reached through
 * that door. A region with no such box for any design goes to `open`, the last resort
 * (17 M24), as the fixture's 2 × 3 huts do. So the region keeps the portal promise exactly
 * when its shape does.
 *
 * Loot rolls each cell's chance and takes the cell's tier (52, "Tier zones"), where a loot
 * disc stands clear of the walls and the door. A hut sites no core elements; any the brief
 * lists are left for the report to name (51 stage 8).
 *
 * `observe`, when given, sees the house's design, allocation and realization (`BuildingTrace`).
 */
export function buildHut(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const size = brief.cellSize, mask = createRegionMask(brief);
  const seed = Math.floor(rng(brief.seed, `${brief.id}:hut-design`).next() * 2 ** 31);
  let site: Site | undefined;
  for (const { spaces, boxes } of LARGER) {
    const houses = new Map<string, House | null>();
    const built = (w: number, h: number, side: Side) => {
      const key = `${w},${h},${side}`;
      if (!houses.has(key)) houses.set(key, larger(spaces, w, h, side, size, seed) ?? null);
      return houses.get(key) ?? undefined;
    };
    site = siteHut(brief, mask, boxes, `${brief.id}:hut-site-${spaces}`, built);
    if (site) break;
  }
  site ??= siteHut(brief, mask, [[BOX, BOX]], `${brief.id}:hut-site`, (_w, _h, side) => house(size, side));
  if (!site) return buildOpen(brief);

  const { design, allocation, realization } = site.house;
  const element = { label: 'hut-building', x: site.x * size, y: site.y * size, template: realization.template! };
  observe?.({ label: element.label, origin: { x: element.x, y: element.y }, cellSize: size, design, allocation, realization });
  const shapes = elementShapes(element, true), radius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(c => [`${c.x},${c.y}`, zone] as const)));
  const lootRandom = rng(brief.seed, `${brief.id}:hut-loot`), loot: LootSite[] = [];
  for (const cell of mask.cells) {
    const zone = zones.get(`${cell.x},${cell.y}`)!, roll = lootRandom.next(), jx = lootRandom.next(), jy = lootRandom.next();
    if (roll >= zone.lootChance) continue;
    const x = (cell.x + 0.35 + jx * 0.3) * size, y = (cell.y + 0.35 + jy * 0.3) * size, disc = circle(x, y, radius);
    if (mask.contains(disc) && !shapes.some(shape => shapesOverlap(disc, shape))) loot.push({ x, y, tier: zone.tier });
  }

  const parts = element.template.parts;
  return { version: 'region-2', brief: structuredClone(brief), elements: [element], coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 1, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0 } };
}

type Site = { x: number; y: number; house: House };

/**
 * The first box of `boxes` that keeps the region's promise, with its house, or nothing. Sizes
 * and then each size's boxes go in a seeded order on `channel`. `built` gives the box's house
 * with its door on a side, or nothing where that side can't take it.
 */
function siteHut(brief: RegionBrief, mask: ReturnType<typeof createRegionMask>, boxes: ReadonlyArray<readonly [number, number]>, channel: string,
  built: (w: number, h: number, side: Side) => House | undefined): Site | undefined {
  const xs = mask.cells.map(c => c.x), ys = mask.cells.map(c => c.y);
  const width = Math.max(...xs) - Math.min(...xs) + 1, height = Math.max(...ys) - Math.min(...ys) + 1;
  const key = (x: number, y: number) => `${x},${y}`;
  const fits = (x: number, y: number, inBox: (x: number, y: number) => boolean) => {
    for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) if (!mask.has(i, j) || inBox(i, j)) return false;
    return true;
  };
  // Label the blocks a hunter can stand on, joined where it can step one cell across.
  const label = (inBox: (x: number, y: number) => boolean) => {
    const labels = new Map<string, number>();
    for (const start of mask.cells) {
      if (labels.has(key(start.x, start.y)) || !fits(start.x, start.y, inBox)) continue;
      const id = labels.size, queue = [start];
      labels.set(key(start.x, start.y), id);
      for (let head = 0; head < queue.length; head++) {
        const { x, y } = queue[head]!;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
          if (labels.has(key(nx, ny)) || !fits(nx, ny, inBox)) continue;
          labels.set(key(nx, ny), id); queue.push({ x: nx, y: ny });
        }
      }
    }
    return labels;
  };

  // Each portal's approach: the cells two deep inward along it, and the blocks a hunter stands on there.
  const approach = new Set<string>(), entrances: string[] = [];
  for (const { portal: { axis, x, y, length }, inward } of portalStands(brief, mask)) {
    const blocks: string[] = [];
    for (let i = 0; i < length; i++) for (let d = 0; d < BODY; d++) {
      const depth = inward.x + inward.y > 0 ? d : -1 - d;
      approach.add(axis === 'h' ? key(x + i, y + depth) : key(x + depth, y + i));
    }
    for (let i = 0; i + BODY <= length; i++) {
      const corner = inward.x + inward.y > 0 ? 0 : -BODY;
      blocks.push(axis === 'h' ? key(x + i, y + corner) : key(x + corner, y + i));
    }
    const entrance = blocks.find(block => { const [bx, by] = block.split(',').map(Number) as [number, number]; return fits(bx, by, () => false); });
    if (entrance) entrances.push(entrance);
  }

  let empty: Map<string, number> | undefined;
  const random = rng(brief.seed, channel);
  for (const [w, h] of random.shuffle(boxes)) {
    if (width < w + MARGIN || height < h + MARGIN) continue;
    empty ??= label(() => false);
    const places = random.shuffle(mask.rectangles(w, h)).map(box => ({ x: Math.round(box.x / mask.cellSize), y: Math.round(box.y / mask.cellSize) }));
    for (const { x, y } of places) {
      const sides = random.shuffle(SIDES);
      const inBox = (i: number, j: number) => i >= x && i < x + w && j >= y && j < y + h;
      let blocked = false;
      for (let j = y; j < y + h && !blocked; j++) for (let i = x; i < x + w && !blocked; i++) blocked = approach.has(key(i, j));
      if (blocked) continue;
      // A convex box with a clear ring a hunter wide can't divide the yard: a route through it goes round.
      let ring = true;
      for (let j = y - BODY; j < y + h + BODY && ring; j++) for (let i = x - BODY; i < x + w + BODY && ring; i++) ring = mask.has(i, j);
      const yard = ring ? empty : label(inBox);
      // Entrances stay in the yard, since the box is off every approach. Those the empty region joined must stay joined.
      const joined = new Map<number, number | undefined>();
      let divided = false;
      for (const e of ring ? [] : entrances) {
        const before = empty.get(e)!;
        if (!joined.has(before)) joined.set(before, yard.get(e));
        else divided ||= joined.get(before) !== yard.get(e);
      }
      if (divided) continue;
      const reached = new Set(entrances.map(e => yard.get(e)));
      // Each doorstep block must be yard that a portal reaches.
      const clear = (step: string) => yard.has(step) && (!entrances.length || reached.has(yard.get(step)));
      for (const side of sides) {
        const house = built(w, h, side);
        if (!house) continue;
        const steps = house.steps.map(t => side === 'N' ? key(x + t, y - BODY) : side === 'S' ? key(x + t, y + h)
          : side === 'W' ? key(x - BODY, y + t) : key(x + w, y + t));
        if (steps.every(clear)) return { x, y, house };
      }
    }
  }
  return undefined;
}

/** Where the doorstep blocks start along the door's side, in the box's cells: one, or two where the door sits between cells. */
function doorsteps(realization: BuildingRealization): number[] | undefined {
  const door = realization.openings.find(opening => opening.connectionId === 'door');
  if (!door) return undefined;
  const start = (door.run.axis === 'h' ? door.run.x : door.run.y) + door.center - BODY / 2;
  return [...new Set([Math.floor(start), Math.ceil(start)])];
}

const realized = (cellSize: number) => ({ cellSize, thickness: WALL, encloses: true, exteriorOrder: SIDES, corners: 'horizontal' as const });

/**
 * The one-space house in its box's local world units: four walls, a door on `door`, and a
 * window on the opposite wall, each a doorway wide (52's worked case) and centred. It
 * encloses, so it has a roof.
 */
function house(size: number, door: Side): House {
  const cells = Array.from({ length: BOX * BOX }, (_, i) => ({ x: i % BOX, y: Math.floor(i / BOX) }));
  const design: BuildingDesign = {
    spaces: [{ id: 'room', area: { min: BOX * BOX, max: BOX * BOX }, outside: 'prefer', tags: ['house'] }],
    connections: [
      { id: 'door', a: 'room', b: OUTSIDE, kind: 'door', side: door },
      { id: 'window', a: 'room', b: OUTSIDE, kind: 'window', side: OPPOSITE[door] },
    ],
  };
  const allocation = { footprint: cells, spaces: [{ id: 'room', cells }] };
  const realization = realizeBuilding(design, allocation, realized(size));
  // This fixed design always fits. A miss here is an implementation defect, not a new fallback.
  if (!realization.template || realization.issues.length || realization.misses.length) throw new Error('The fixed hut design could not be realized.');
  return { design, allocation, realization, steps: doorsteps(realization)! };
}

/**
 * A house of `spaces` spaces in a `w` × `h` box with its door on `side`, or nothing. The front
 * space holds the door and a window; each other space is asked for a door into the
 * front and a window. The allocation adds interior doors where the asked ones can't join every
 * space. A house whose outside door misses, or whose openings don't join every space, isn't
 * used: each space is reached through the one door. Missed windows and asked doors are
 * guidance, and stay as misses (M29).
 */
function larger(spaces: number, w: number, h: number, side: Side, size: number, seed: number): House | undefined {
  const cells = Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
  const ids = Array.from({ length: spaces }, (_, i) => i ? `back-${i}` : 'front');
  const asked: BuildingDesign = {
    spaces: ids.map(id => ({ id, area: { min: 9, max: w * h }, outside: 'prefer' as const, tags: [id === 'front' ? 'entry' : 'room'] })),
    connections: [
      { id: 'door', a: 'front', b: OUTSIDE, kind: 'door', side },
      { id: 'window', a: 'front', b: OUTSIDE, kind: 'window' },
      ...ids.slice(1).flatMap((id, i) => [
        { id: `link-${i + 1}`, a: 'front', b: id, kind: 'door' as const },
        { id: `window-${i + 1}`, a: id, b: OUTSIDE, kind: 'window' as const },
      ]),
    ],
  };
  const allocated = allocateBuilding(asked, cells, { seed });
  if (!allocated.ok) return undefined;
  const { design, allocation } = allocated, realization = realizeBuilding(design, allocation, realized(size));
  const steps = doorsteps(realization);
  if (!realization.template || realization.issues.length || !steps) return undefined;
  const reached = new Set(['front']);
  for (let grown = true; grown;) {
    grown = false;
    for (const { kind, a, b } of realization.openings) {
      if (kind === 'window' || a === OUTSIDE || b === OUTSIDE || reached.has(a) === reached.has(b)) continue;
      reached.add(a); reached.add(b); grown = true;
    }
  }
  return reached.size === spaces ? { design, allocation, realization, steps } : undefined;
}
