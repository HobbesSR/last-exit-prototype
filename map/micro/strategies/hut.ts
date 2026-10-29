import type { Side } from '../port-terms.ts';
import { circle, rect } from '../../../shared/shape.ts';
import { rng } from '../random.ts';
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
import { delegateYardCandidates, yardDiagnostics, yardExtentBoxes } from '../yard-handoff.ts';
import type { YardDiagnostics } from '../yard-handoff.ts';
import type { BuilderCanvas } from '../canvas.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { executeDelegation, flattenDelegationResult } from '../delegation-execute.ts';
import type { ExecutionContext, ExecutionOptions, ExecutionRegistry } from '../delegation-execute.ts';
import { builtRegion } from '../result.ts';

/** The one-space house's box in cells (54, proposed). */
const BOX = 4;
/** A hunter fits a 2 × 2 block of cells, and moving it by one cell sweeps a 2 × 3 rectangle. */
const BODY = 2;
/** Bound composition work in unusually large merged regions; residual yards may still take cover. */
const MAX_HOUSES = 8;
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
 * The `hut` region type (54): up to eight small buildings with optional yard-to-cover delegation.
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
 * Repeat that design search for additional houses, with two-cell inter-house aisles and a
 * complete two-cell exterior access ring. Cumulative floods protect every earlier doorstep
 * as well as the portals. Stop at the first no-fit search or eight houses, then offer unused
 * yard lobes without changing the houses.
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

/** Detached observations of the optional yard delegation attempt. */
export type HutYardDiagnostics = YardDiagnostics<'no-fill' | 'no-house'>;
export interface HutExecutionOptions extends ExecutionOptions {
  observeYard?: (diagnostics: HutYardDiagnostics) => void;
}
/** Owning generation object for inspection and versioned snapshot recovery (20.7). */
export function buildHutGeneration(brief: RegionBrief, options: HutExecutionOptions = {}) {
  // Preparation rechecks receivers as interfaces change. Reuse only an exact
  // interface's cover preview within this invocation, including for dispatch.
  const { observeYard, ...executionOptions } = options;
  return executeDelegation(brief, { ...HUT_EXECUTION_REGISTRY,
    hut: { ...HUT_EXECUTION_REGISTRY.hut!, build: (b, c, observe) => buildRetainedHut(b, c, observe, observeYard) },
    cover: previewedCoverExecution() }, executionOptions);
}

export const HUT_EXECUTION_REGISTRY: ExecutionRegistry = Object.freeze({
  hut: { version: 'hut-yard-4', build: buildRetainedHut },
  cover: COVER_EXECUTION,
});

function buildRetainedHut(brief: RegionBrief, context: ExecutionContext, observe?: BuildingObserver, observeYard?: HutExecutionOptions['observeYard']): BuiltRegion {
  const size = brief.cellSize, mask = createFillMask(brief), accessMask = createAccessMask(brief);
  if (!mask.cells.length) {
    observeYard?.(yardDiagnostics(brief.id, 'no-fill'));
    return context.empty('hut has no usable fill');
  }
  const seed = Math.floor(rng(brief.seed, `${brief.id}:hut-design`).next() * 2 ** 31);
  const canvas = createBuilderCanvas(brief), sites: Site[] = [];
  // A bounded primary composition pass, before any yard is offered to cover.
  // Preserve the original first-house channels; each later house has its own.
  for (let index = 0; index < MAX_HOUSES; index++) {
    const suffix = index ? `:house-${index}` : '';
    let site: Site | undefined;
    for (const { spaces, boxes } of LARGER) {
      const houses = new Map<string, House | null>();
      const cached = (w: number, h: number, side: Side) => {
        const key = `${w},${h},${side}`;
        if (!houses.has(key)) houses.set(key, houseFor(w, h, side, spaces, size, seed) ?? null);
        return houses.get(key) ?? undefined;
      };
      site = siteHut(brief, mask, accessMask, boxes, `${brief.id}:hut-site-${spaces}${suffix}`, cached, sites, canvas);
      if (site) break;
    }
    const smallBoxes: ReadonlyArray<readonly [number, number]> = [[BOX, BOX], [BOX, 3], [3, BOX], [3, 3]];
    site ??= siteHut(brief, mask, accessMask, smallBoxes, `${brief.id}:hut-site${suffix}`,
      (w, h, side) => houseFor(w, h, side, 1, size, seed), sites, canvas);
    if (!site) break;
    const { design, allocation, realization } = site.house.details;
    const label = index ? `hut-building-${index + 1}` : 'hut-building';
    const [element] = placedElements(site.house, label, site.x, site.y, size) as [RegionElement];
    const access = site.steps.map(step => {
      const [x, y] = step.split(',').map(Number) as [number, number];
      return rect(x * size, y * size, BODY * size, BODY * size);
    });
    if (!canvas.commit({ elements: [element], access })) throw new Error('Hut placement failed its canvas commit.');
    sites.push(site);
    observe?.({ label, origin: { x: element.x, y: element.y }, cellSize: size, design, allocation, realization });
  }
  if (!sites.length) {
    observeYard?.(yardDiagnostics(brief.id, 'no-house'));
    return context.empty('hut has no house with a reachable doorstep');
  }
  const elements = [...canvas.elements];
  const shapes = elements.flatMap(e => elementShapes(e, true)), radius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
  delegateYard(brief, sites, elements, context, observeYard);
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

  return builtRegion(brief, elements, loot);
}

type Site = { x: number; y: number; house: House; steps: string[] };

/** Try a capped number of peripheral boxes, allowing the coordinator to move yard cords. */
function delegateYard(brief: RegionBrief, sites: Site[], elements: RegionElement[], context: ExecutionContext, observe?: HutExecutionOptions['observeYard']): void {
  delegateYardCandidates<'no-fill' | 'no-house'>(brief, context, {
    retainedBox: { x: sites[0]!.x, y: sites[0]!.y, ...sites[0]!.house.demand.body },
    retainedBoxes: sites.map(site => ({ x: site.x, y: site.y, ...site.house.demand.body })),
    steps: sites.flatMap(site => site.steps.map(step => step.split(',').map(Number) as [number, number])), elements, label: 'hut',
    offersFor: (reserved, diagnostics) => peripheralOffers(brief, reserved, diagnostics), observe,
  });
}

/**
 * Candidate rectangles start flush against each extent corner or edge. Several
 * scales allow a smaller useful box when a larger lobe meets a portal or house.
 * Require a complete owned rectangle and at least a 3-by-3 pocket for cover;
 * refusals and narrow remnants remain with the hut. The fixed candidate cap
 * limits the number of expensive probes, not their cost: preparation and routing
 * still grow with region geometry and the accepted batch.
 */
function peripheralOffers(brief: RegionBrief, reserved: Set<string>, diagnostics: HutYardDiagnostics): PatchOffer[] {
  const owned = createRegionMask(brief), cells = owned.cells;
  const { boxes } = yardExtentBoxes(cells);
  const seen = new Set<string>(), offers: PatchOffer[] = [];
  for (const { x, y, w, h } of boxes) {
    const id = `${x},${y},${w},${h}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (w * h > cells.length) continue;
    const patch = [];
    let complete = true;
    for (let j = y; j < y + h && complete; j++) for (let i = x; i < x + w; i++) {
      if (!owned.has(i, j)) { complete = false; break; }
      patch.push({ x: i, y: j });
    }
    if (!complete) continue;
    diagnostics.considered++;
    if (patch.some(c => reserved.has(`${c.x},${c.y}`))) { diagnostics.filtered++; continue; }
    offers.push({ key: `yard:${id}`, cells: patch, type: 'cover', reasonTags: ['unused-yard-lobe'] });
    if (offers.length === 36) break;
  }
  return offers;
}

/**
 * The first box of `boxes` that keeps the region's promise, with its house, or nothing. Sizes
 * and then each size's boxes go in a seeded order on `channel`. `built` gives the box's house
 * with its door on a side, or nothing where that side can't take it.
 */
function siteHut(brief: RegionBrief, mask: ReturnType<typeof createRegionMask>, accessMask: ReturnType<typeof createRegionMask>, boxes: ReadonlyArray<readonly [number, number]>, channel: string,
  built: (w: number, h: number, side: Side) => House | undefined, sites: Site[], canvas: BuilderCanvas): Site | undefined {
  const xs = mask.cells.map(c => c.x), ys = mask.cells.map(c => c.y);
  const width = Math.max(...xs) - Math.min(...xs) + 1, height = Math.max(...ys) - Math.min(...ys) + 1;
  const key = (x: number, y: number) => `${x},${y}`;
  const occupied = (x: number, y: number) => sites.some(site => x >= site.x && y >= site.y
    && x < site.x + site.house.demand.body.w && y < site.y + site.house.demand.body.h);
  const fits = (x: number, y: number, inBox: (x: number, y: number) => boolean) => {
    for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) if (!accessMask.has(i, j) || occupied(i, j) || inBox(i, j)) return false;
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
      const footprint = rect(x * mask.cellSize, y * mask.cellSize, w * mask.cellSize, h * mask.cellSize);
      if (!canvas.fits(footprint) || !canvas.spaced(footprint, BODY * mask.cellSize)) continue;
      const sides = random.shuffle(SIDES);
      const inBox = (i: number, j: number) => i >= x && i < x + w && j >= y && j < y + h;
      // A convex box with a clear ring a hunter wide can't divide the yard: a route through it goes round.
      let ring = true;
      for (let j = y - BODY; j < y + h + BODY && ring; j++) for (let i = x - BODY; i < x + w + BODY && ring; i++) ring = accessMask.has(i, j);
      // Additional houses need a complete exterior bypass, including in unported lobes.
      if (sites.length && !ring) continue;
      const shortcut = ring && !sites.length;
      const yard = shortcut ? empty : label(inBox);
      // Entrances stay in the yard, since the box is in the fill and off every margin. Those the empty region joined must stay joined.
      const joined = new Map<number, number | undefined>();
      let divided = false;
      for (const e of shortcut ? [] : entrances) {
        const before = empty.get(e)!;
        if (!joined.has(before)) joined.set(before, yard.get(e));
        else divided ||= joined.get(before) !== yard.get(e);
      }
      if (divided) continue;
      const reached = new Set(entrances.map(e => yard.get(e)));
      // Each doorstep block must be yard that a portal reaches.
      const clear = (step: string) => yard.has(step) && (!entrances.length || reached.has(yard.get(step)));
      if (!sites.every(site => site.steps.every(clear))) continue;
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
