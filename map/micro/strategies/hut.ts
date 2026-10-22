import type { Side } from '../port-terms.ts';
import { circle, rect } from '../../../shared/shape.ts';
import { rng } from '../index.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes, shapesOverlap } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { portalStands } from '../portals.ts';
import { boxesAgainstHints } from '../hints.ts';
import { HOUSE } from '../placeables/house.ts';
import type { HouseDetails } from '../placeables/house.ts';
import { placedElements } from '../placeables/placeable.ts';
import type { Placed } from '../placeables/placeable.ts';
import type { BuildingObserver } from '../building/trace.ts';
import type { BuiltRegion, LootSite, RegionBrief, RegionElement } from '../types.ts';
import { COVER_EXECUTION, previewedCoverExecution } from './cover.ts';
import type { PatchOffer } from '../delegation.ts';
import { createAddressedArea } from '../addressed.ts';
import { executeDelegation, flattenDelegationResult } from '../delegation-execute.ts';
import type { ExecutionContext, ExecutionOptions, ExecutionRegistry } from '../delegation-execute.ts';

/** The one-space house's box in cells (54, proposed). */
const BOX = 4;
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

const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
/** A box's house with its door on one side, as `HOUSE` builds it, or nothing where it refuses. */
type House = Placed<HouseDetails>;
const houseFor = (w: number, h: number, door: Side, spaces: number, size: number, seed: number): House | undefined => {
  const result = HOUSE.build({ w, h, door, spaces, seed }, size);
  return 'refused' in result ? undefined : result;
};

/**
 * The `hut` region type (54): one small building with optional yard-to-cover delegation.
 *
 * The builder works in cells, where a hunter is a 2 × 2 block of yard cells. It tries designs
 * largest first: three spaces, then two, then the one-space house in a 4 × 4 box. Each design
 * tries its boxes in a
 * seeded order. It takes the first contained box that:
 * - lies in the reduced fill, so off every portal's clear margin, where its hunter stands are (20.6)
 * - leaves every two portals that the empty region joined still joined through the yard
 * - has a side whose doorstep, the 2 × 2 blocks outside the door, the yard joins to a portal.
 *
 * A larger design's spaces are allocated in its box (`allocateBuilding`), joined by interior
 * doors, with one door outside and windows as guidance. A design whose door or interior doors
 * miss on a side doesn't take that side. The house stands in the box with walls and a roof.
 * It has one door outside, so no route runs through it, and every space is reached through
 * that door. A region with no such box takes the terminal empty path (20.7).
 * After placement, unused yard lobes may be offered without changing the house.
 *
 * Loot rolls each cell's chance and takes the cell's tier (52, "Tier zones"), where a loot
 * disc stands clear of the walls and the door. A hut sites no core elements; any the brief
 * lists are left for the report to name (51 stage 8).
 *
 * `observe`, when given, sees the house's design, allocation and realization (`BuildingTrace`).
 */
export function buildHut(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const result = flattenDelegationResult(buildHutGeneration(brief, observe ? { observe } : {}));
  // Chain saves derive this exact brief from the Layout. Canonical ordering and
  // derived margins belong to the owning execution, not the production adapter.
  return { ...result, brief };
}

/** Owning generation object for inspection and versioned snapshot recovery (20.7). */
export function buildHutGeneration(brief: RegionBrief, options: ExecutionOptions = {}) {
  // Preparation rechecks receivers as interfaces change. Reuse only an exact
  // interface's cover preview within this invocation, including for dispatch.
  return executeDelegation(brief, { ...HUT_EXECUTION_REGISTRY, cover: previewedCoverExecution() }, options);
}

export const HUT_EXECUTION_REGISTRY: ExecutionRegistry = Object.freeze({
  hut: { version: 'hut-yard-1', build: buildRetainedHut },
  cover: COVER_EXECUTION,
});

function buildRetainedHut(brief: RegionBrief, context: ExecutionContext, observe?: BuildingObserver): BuiltRegion {
  const size = brief.cellSize, mask = createFillMask(brief), accessMask = createAccessMask(brief);
  if (!mask.cells.length) return context.empty('hut has no usable fill');
  const seed = Math.floor(rng(brief.seed, `${brief.id}:hut-design`).next() * 2 ** 31);
  let site: Site | undefined;
  for (const { spaces, boxes } of LARGER) {
    const houses = new Map<string, House | null>();
    const cached = (w: number, h: number, side: Side) => {
      const key = `${w},${h},${side}`;
      if (!houses.has(key)) houses.set(key, houseFor(w, h, side, spaces, size, seed) ?? null);
      return houses.get(key) ?? undefined;
    };
    site = siteHut(brief, mask, accessMask, boxes, `${brief.id}:hut-site-${spaces}`, cached);
    if (site) break;
  }
  const smallBoxes: ReadonlyArray<readonly [number, number]> = [[BOX, BOX], [BOX, 3], [3, BOX], [3, 3]];
  site ??= siteHut(brief, mask, accessMask, smallBoxes, `${brief.id}:hut-site`, (w, h, side) => houseFor(w, h, side, 1, size, seed));
  if (!site) return context.empty('hut has no house with a reachable doorstep');

  const { design, allocation, realization } = site.house.details;
  const [element] = placedElements(site.house, 'hut-building', site.x, site.y, size) as [RegionElement];
  observe?.({ label: element.label, origin: { x: element.x, y: element.y }, cellSize: size, design, allocation, realization });
  const shapes = elementShapes(element, true), radius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
  const offers = yardOffers(brief, site);
  if (offers.length) context.delegate(offers, { blockers: shapes });
  brief = context.brief;
  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(c => [`${c.x},${c.y}`, zone] as const)));
  const lootRandom = rng(brief.seed, `${brief.id}:hut-loot`), loot: LootSite[] = [];
  const ownedMask = createRegionMask(brief);
  for (const cell of ownedMask.cells) {
    const zone = zones.get(`${cell.x},${cell.y}`)!, roll = lootRandom.next(), jx = lootRandom.next(), jy = lootRandom.next();
    if (roll >= zone.lootChance) continue;
    const x = (cell.x + 0.35 + jx * 0.3) * size, y = (cell.y + 0.35 + jy * 0.3) * size, disc = circle(x, y, radius);
    if (ownedMask.contains(disc) && !shapes.some(shape => shapesOverlap(disc, shape))) loot.push({ x, y, tier: zone.tier });
  }

  const parts = element.template.parts;
  return { version: 'region-2', brief: structuredClone(brief), elements: [element], coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 1, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0 } };
}

type Site = { x: number; y: number; house: House; steps: string[] };

/**
 * Keep the house and its two-cell yard, and a hunter standing-block tree from its
 * doorstep to the original entrances. Only the unused connected yard lobes are
 * offered. This is hut authorship; the child receives no private house state.
 */
function yardOffers(brief: RegionBrief, site: Site): PatchOffer[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const owned = createRegionMask(brief), fill = createFillMask(brief), access = createAccessMask(brief);
  const { w, h } = site.house.demand.body;
  const inHouse = (x: number, y: number) => x >= site.x && x < site.x + w && y >= site.y && y < site.y + h;
  const area = createAddressedArea(owned), size = brief.cellSize;
  // The house and its two-cell yard, then non-fill cells and the two-cell perimeter band around it.
  area.mark(rect((site.x - BODY) * size, (site.y - BODY) * size, (w + 2 * BODY) * size, (h + 2 * BODY) * size));
  area.markCells(owned.cells.filter(c => !area.addressed(c.x, c.y) && (!fill.has(c.x, c.y)
    || [-2, -1, 1, 2].some(d => !owned.has(c.x + d, c.y) || !owned.has(c.x, c.y + d)))));
  const fits = (x: number, y: number) => {
    for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) if (!access.has(i, j) || inHouse(i, j)) return false;
    return true;
  };
  // A zero-cost step inside intentional yard prefers existing circulation over
  // hundreds of separate spokes when a large region has many perimeter portals.
  const root = site.steps[0]!, parents = new Map<string, string | null>([[root, null]]);
  const distances = new Map([[root, 0]]), buckets: string[][] = [[root]];
  const entrances: string[] = [];
  for (const { portal: p } of portalStands(brief)) {
    let entrance: string | undefined;
    for (let i = 0; i + BODY <= p.length; i++) {
      const x = p.axis === 'h' ? p.x + i : p.x - 1, y = p.axis === 'h' ? p.y - 1 : p.y + i;
      if (fits(x, y)) { entrance = key(x, y); break; }
    }
    if (!entrance) return [];
    entrances.push(entrance);
  }
  const pending = new Set(entrances);
  for (let distance = 0; distance < buckets.length && pending.size; distance++) for (let head = 0; head < buckets[distance]!.length && pending.size; head++) {
    const at = buckets[distance]![head]!;
    if (distances.get(at) !== distance) continue;
    pending.delete(at);
    const [x, y] = at.split(',').map(Number) as [number, number];
    for (const [nx, ny] of [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]] as const) {
      const next = key(nx, ny);
      if (!fits(nx, ny)) continue;
      let cost = 0;
      for (let j = ny; j < ny + BODY; j++) for (let i = nx; i < nx + BODY; i++) if (!area.addressed(i, j)) cost = 1;
      const nextDistance = distance + cost;
      if (nextDistance < (distances.get(next) ?? Infinity)) {
        distances.set(next, nextDistance); parents.set(next, at);
        (buckets[nextDistance] ??= []).push(next);
      }
    }
  }
  // Do not offer land if the house's actual yard cannot connect an original entrance.
  if (pending.size) return [];
  for (const entrance of entrances) {
    for (let at: string | null = entrance; at !== null; at = parents.get(at)!) {
      const [x, y] = at.split(',').map(Number) as [number, number];
      for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) if (!area.addressed(i, j)) area.markCells([{ x: i, y: j }]);
    }
  }
  // The canonical first cell uniquely names a connected lobe in this batch.
  // Keep identities short even on macro-sized yards; snapshots retain its full footprint.
  return area.unaddressedComponents().filter(cells => cells.length >= 9)
    .map((cells): PatchOffer => ({ key: `yard:${cells[0]!.x},${cells[0]!.y}`, cells, type: 'cover', reasonTags: ['unused-yard-lobe'] }));
}

/**
 * The first box of `boxes` that keeps the region's promise, with its house, or nothing. Sizes
 * and then each size's boxes go in a seeded order on `channel`. `built` gives the box's house
 * with its door on a side, or nothing where that side can't take it.
 */
function siteHut(brief: RegionBrief, mask: ReturnType<typeof createRegionMask>, accessMask: ReturnType<typeof createRegionMask>, boxes: ReadonlyArray<readonly [number, number]>, channel: string,
  built: (w: number, h: number, side: Side) => House | undefined): Site | undefined {
  const xs = mask.cells.map(c => c.x), ys = mask.cells.map(c => c.y);
  const width = Math.max(...xs) - Math.min(...xs) + 1, height = Math.max(...ys) - Math.min(...ys) + 1;
  const key = (x: number, y: number) => `${x},${y}`;
  const fits = (x: number, y: number, inBox: (x: number, y: number) => boolean) => {
    for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) if (!accessMask.has(i, j) || inBox(i, j)) return false;
    return true;
  };
  // Label the blocks a hunter can stand on, joined where it can step one cell across.
  const label = (inBox: (x: number, y: number) => boolean) => {
    const labels = new Map<string, number>();
    for (const start of accessMask.cells) {
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

  // Each portal's entrance: a block a hunter stands on, straddling the seam in the clear margin (20.6).
  const entrances: string[] = [];
  for (const { portal: { axis, x, y, length } } of portalStands(brief)) {
    const blocks: string[] = [];
    for (let i = 0; i + BODY <= length; i++) {
      blocks.push(axis === 'h' ? key(x + i, y - 1) : key(x - 1, y + i));
    }
    const entrance = blocks.find(block => { const [bx, by] = block.split(',').map(Number) as [number, number]; return fits(bx, by, () => false); });
    if (entrance) entrances.push(entrance);
  }

  let empty: Map<string, number> | undefined;
  const random = rng(brief.seed, channel);
  for (const [w, h] of random.shuffle(boxes)) {
    if (width < w || height < h) continue;
    empty ??= label(() => false);
    const hinted = boxesAgainstHints(brief, w, h);
    const seen = new Set(hinted.map(box => key(box.x, box.y)));
    const places = [...random.shuffle(hinted), ...random.shuffle(mask.rectangles(w, h))
      .map(box => ({ x: Math.round(box.x / mask.cellSize), y: Math.round(box.y / mask.cellSize) }))
      .filter(box => !seen.has(key(box.x, box.y)))];
    for (const { x, y } of places) {
      let inFill = true;
      for (let j = y; j < y + h && inFill; j++) for (let i = x; i < x + w; i++) if (!mask.has(i, j)) { inFill = false; break; }
      if (!inFill) continue;
      const sides = random.shuffle(SIDES);
      const inBox = (i: number, j: number) => i >= x && i < x + w && j >= y && j < y + h;
      // A convex box with a clear ring a hunter wide can't divide the yard: a route through it goes round.
      let ring = true;
      for (let j = y - BODY; j < y + h + BODY && ring; j++) for (let i = x - BODY; i < x + w + BODY && ring; i++) ring = accessMask.has(i, j);
      const yard = ring ? empty : label(inBox);
      // Entrances stay in the yard, since the box is in the fill and off every margin. Those the empty region joined must stay joined.
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
        const steps = house.details.steps.map(t => side === 'N' ? key(x + t, y - BODY) : side === 'S' ? key(x + t, y + h)
          : side === 'W' ? key(x - BODY, y + t) : key(x + w, y + t));
        if (steps.every(clear)) return { x, y, house, steps };
      }
    }
  }
  return undefined;
}
