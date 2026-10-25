import { compareCells } from '../../kernel/cell.ts';
import { circle, rect } from '../../../shared/shape.ts';
import type { Shape } from '../../../shared/shape.ts';
import { elementShapes, findRegionRoute, shapesOverlap } from '../geometry.ts';
import { rng } from '../random.ts';
import { boundaryBoxFilter, boxesAgainstHints, hintedCells } from '../hints.ts';
import { protectedRoutes } from './scatter.ts';
import { microMetrics } from '../metrics.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { COVER_PIECE, COVER_PIECES } from '../placeables/cover-piece.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import type { BuiltRegion, LootSite, RegionBrief, RegionElement } from '../types.ts';
import type { ExecutionBuilder } from '../delegation-execute.ts';
import { createBuilderCanvas } from '../canvas.ts';
import type { BuilderCanvas } from '../canvas.ts';
import { builtRegion } from '../result.ts';

/**
 * The cover executor implementation (20.7); bump it when `buildCover` output changes. The aggregate
 * `REGION_TYPES_VERSION` tracks a separate contract and does not move this.
 */
export const COVER_EXECUTOR_VERSION = 'cover-types-23';

/**
 * Cover as a delegation receiver: it accepts an inherited interface when its build there
 * has a usable placement. Registries name this entry for direct snapshot recovery.
 */
export const COVER_EXECUTION: ExecutionBuilder = Object.freeze(coverExecution(buildCover));

/**
 * The same receiver for one adopter invocation. Its receiving check and child build share
 * one preview per exact serialized child interface; a fresh entry starts with no previews.
 */
export function previewedCoverExecution(): ExecutionBuilder {
  const previews = new Map<string, BuiltRegion>();
  return coverExecution(child => {
    const key = JSON.stringify(child);
    if (!previews.has(key)) previews.set(key, buildCover(child));
    return previews.get(key)!;
  });
}

function coverExecution(build: (brief: RegionBrief) => BuiltRegion): ExecutionBuilder {
  return { version: COVER_EXECUTOR_VERSION, build,
    receiving: brief => build(brief).elements.length ? null : 'cover has no usable placement in the inherited fill' };
}

/** Cells between slots, one tile, so pieces read as sited rather than strewn. */
const PERIOD = 6;
/**
 * Clear cells between clusters: a doorway (52), so a hunter fits each aisle.
 */
const AISLE = CELL_SCALE.doorway;
const DENSITY = 0.55;
/** The most pieces in one slot's cluster. */
const CLUSTER = 3;

/** The pieces a cluster draws from (`COVER_PIECE`), with their footprints in cells and their chance. */
const PIECES = ([['crate', 0.5], ['barrier', 0.35], ['container', 0.15]] as const)
  .map(([name, weight]) => ({ name, weight, w: COVER_PIECES[name].w, h: COVER_PIECES[name].h }));

function densityOf(brief: RegionBrief): number {
  const density = brief.parameters?.density ?? DENSITY;
  if (typeof density !== 'number' || !(density >= 0 && density <= 1)) throw new Error(`Region ${brief.id}: cover's density must be a number from 0 to 1.`);
  return density;
}

/**
 * The `cover` region type (54): small cover scattered on open ground, with no decomposer.
 *
 * Slots lie on a lattice `PERIOD` cells apart. A slot is taken with chance `density`, by a
 * cluster of up to `CLUSTER` crates, barriers and the odd container, at jittered spots in it.
 * Neighbouring slots keep an aisle between clusters. Candidate boxes stay owned and clear
 * of portal approaches; concave masks also protect one hunter corridor. Hinted runs guide
 * the first piece in each eligible slot. A region too small for a piece stays clear.
 *
 * Loot rolls each cell's chance and takes the cell's tier (52, "Tier zones"). It lands at a
 * cell whose neighbours are all owned and free of cover, so it has standing room. Cover sites
 * no core elements; any the brief lists are left for the report to name (51 stage 8).
 */
export function buildCover(brief: RegionBrief): BuiltRegion {
  return sitedCover(brief).region;
}

/** `buildCover`'s region with the protections its canvas held, so the post-filters commit against the same ones. */
function sitedCover(brief: RegionBrief): { region: BuiltRegion; protectedShapes: readonly Shape[] } {
  const density = densityOf(brief), size = brief.cellSize;
  const cells = [...brief.cells].sort(compareCells);
  // Routes between portals are protected; past 32 portals that search is too dear, and
  // boxes keep an aisle from the boundary instead.
  const boundary = boundaryBoxFilter(brief, AISLE), routed = brief.portals.length <= 32;
  const protectedShapes = routed ? protectedRoutes(brief, 'Cover') : [];

  const hinted = new Map<string, { x: number; y: number }[]>();
  for (const piece of PIECES) for (const [w, h] of [[piece.w, piece.h], [piece.h, piece.w]])
    hinted.set(`${w},${h}`, boxesAgainstHints(brief, w, h));
  const slots = rng(brief.seed, `${brief.id}:cover-slots`), phase = { x: slots.int(0, PERIOD - 1), y: slots.int(0, PERIOD - 1) };
  const firstHint = hintedCells(brief)[0];
  if (firstHint) { phase.x = ((firstHint.x % PERIOD) + PERIOD) % PERIOD; phase.y = ((firstHint.y % PERIOD) + PERIOD) % PERIOD; }
  const onLattice = (value: number, offset: number) => ((value - offset) % PERIOD + PERIOD) % PERIOD === 0;
  const canvas = createBuilderCanvas(brief, protectedShapes);
  const cellBox = (x: number, y: number, w: number, h: number) => rect(x * size, y * size, w * size, h * size);
  const clear = (x: number, y: number, w: number, h: number) => (routed || boundary.fits({ x, y, w, h })) && canvas.fits(cellBox(x, y, w, h));
  for (const slot of cells) {
    if (!onLattice(slot.x, phase.x) || !onLattice(slot.y, phase.y)) continue;
    // Every slot draws the same numbers whether or not it is taken, so one slot's fate never shifts another's.
    const taken = slots.next() < density, wanted = 1 + Math.floor(slots.next() * CLUSTER);
    const draws = Array.from({ length: CLUSTER }, () => ({ pick: slots.next(), turned: slots.next() < 0.5, jx: slots.next(), jy: slots.next(), length: slots.next(), offset: slots.next() }));
    if (!taken) continue;
    // A cluster stays inside the slot's first PERIOD - AISLE cells, so neighbouring clusters keep the aisle.
    // Its bounding box stays owned and clear of portal approaches as it grows.
    let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
    for (const { pick, turned, jx, jy, length, offset } of draws.slice(0, wanted)) {
      let piece = PIECES[0]!;
      for (let sum = 0, i = 0; i < PIECES.length; i++) if (pick < (sum += PIECES[i]!.weight)) { piece = PIECES[i]!; break; }
      const w = turned ? piece.h : piece.w, h = turned ? piece.w : piece.h;
      const hint = box ? undefined : hinted.get(`${w},${h}`)?.find(candidate => candidate.x >= slot.x && candidate.y >= slot.y
        && candidate.x + w <= slot.x + PERIOD - AISLE && candidate.y + h <= slot.y + PERIOD - AISLE);
      const x = hint?.x ?? slot.x + Math.floor(jx * (PERIOD - AISLE - w + 1));
      const y = hint?.y ?? slot.y + Math.floor(jy * (PERIOD - AISLE - h + 1));
      const grown = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x + w), y1: Math.max(box.y1, y + h) } : { x0: x, y0: y, x1: x + w, y1: y + h };
      if (!canvas.spaced(cellBox(x, y, w, h)) || !clear(grown.x0, grown.y0, grown.x1 - grown.x0, grown.y1 - grown.y0)) continue;
      const assembly = placedElements(expectPlaced(COVER_PIECE.build({ piece: piece.name, turned, length, offset }, size)), `cover-${piece.name}-${canvas.elements.length + 1}`, x, y, size);
      if (!canvas.commit({ elements: assembly })) continue;
      box = grown;
    }
  }

  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(c => [`${c.x},${c.y}`, zone] as const)));
  const lootRandom = rng(brief.seed, `${brief.id}:cover-loot`), loot: LootSite[] = [];
  const lootOwned = new Set(brief.cells.map(c => `${c.x},${c.y}`));
  const standing = (x: number, y: number) => {
    for (let j = y - 1; j <= y + 1; j++) for (let i = x - 1; i <= x + 1; i++) if (!lootOwned.has(`${i},${j}`)) return false;
    return canvas.spaced(cellBox(x - 1, y - 1, 3, 3));
  };
  for (const cell of cells) {
    const zone = zones.get(`${cell.x},${cell.y}`)!, roll = lootRandom.next(), jx = lootRandom.next(), jy = lootRandom.next();
    if (roll < zone.lootChance && standing(cell.x, cell.y)) loot.push({ x: (cell.x + 0.35 + jx * 0.3) * size, y: (cell.y + 0.35 + jy * 0.3) * size, tier: zone.tier });
  }

  const elements = [...canvas.elements];
  return { protectedShapes, region: builtRegion(brief, elements, loot) };
}

/** Commits each piece as its own assembly, as `buildCover` did. Siting has accepted them, so a refusal is an invariant failure. */
function commitPieces(brief: RegionBrief, canvas: BuilderCanvas, elements: readonly RegionElement[]) {
  for (const element of elements) if (!canvas.commit({ elements: [element] }))
    throw new Error(`Region ${brief.id}: the canvas refused cover piece ${element.label}, which cover's siting accepted.`);
}

/**
 * A sited point that cover and loot leave clear for `radius` around it. A body of radius
 * `reach`, by default `radius`, must still be able to walk to it.
 */
export interface ClearSite { x: number; y: number; radius: number; reach?: number }

/**
 * `buildCover`'s pieces and loot, less any that would claim a site's standing room. A piece
 * that would cut a site's route from `root` is dropped too, so a core element region keeps
 * its sites reachable from its first portal. Dropping cover can't break a portal route.
 */
export function coverAround(brief: RegionBrief, sites: readonly ClearSite[], root?: { x: number; y: number }): Pick<BuiltRegion, 'elements' | 'loot'> {
  const lootRadius = microMetrics({ cellSize: brief.cellSize, bodyProfile: 'cell' }).lootRadius;
  const discs = sites.map(site => circle(site.x, site.y, site.radius));
  const { region: cover, protectedShapes } = sitedCover(brief);
  const canvas = createBuilderCanvas(brief, protectedShapes), blockers: Shape[] = [];
  for (const element of cover.elements) {
    const shapes = elementShapes(element);
    if (shapes.some(shape => discs.some(disc => shapesOverlap(shape, disc)))) continue;
    const next = [...blockers, ...shapes];
    if (root && sites.some(site => !findRegionRoute(canvas.access, next, root, site, site.reach ?? site.radius))) continue;
    commitPieces(brief, canvas, [element]);
    blockers.push(...shapes);
  }
  const loot = cover.loot.filter(site => !discs.some(disc => shapesOverlap(circle(site.x, site.y, lootRadius), disc)));
  return { elements: [...canvas.elements], loot };
}

/**
 * Makes sure some cover stands within `within` of `site`'s clear disc: if none of `elements`
 * does, one container is added there, if the region has room. Like `buildCover`'s clusters,
 * it keeps `AISLE` clear cells from every other piece and leaves portal approaches clear. It never cuts `site`'s route from `root`.
 * Loot it would cover is dropped. The pick among places that qualify is seeded.
 */
export function coverNear(brief: RegionBrief, cover: Pick<BuiltRegion, 'elements' | 'loot'>, site: ClearSite, within: number,
  root?: { x: number; y: number }): Pick<BuiltRegion, 'elements' | 'loot'> {
  const size = brief.cellSize, disc = circle(site.x, site.y, site.radius), near = circle(site.x, site.y, site.radius + within);
  const blockers = cover.elements.flatMap(element => elementShapes(element));
  if (blockers.some(shape => shapesOverlap(shape, near))) return cover;

  // Routes between portals are protected; past 32 portals that search is too dear, and
  // boxes keep an aisle from the boundary instead.
  const boundary = boundaryBoxFilter(brief, AISLE), routed = brief.portals.length <= 32;
  const protectedShapes = routed ? protectedRoutes(brief, 'Cover') : [];
  const canvas = createBuilderCanvas(brief, protectedShapes);
  commitPieces(brief, canvas, cover.elements);
  const fill = canvas.fill.cells;
  const clear = (x: number, y: number, w: number, h: number) => {
    const box = rect(x * size, y * size, w * size, h * size);
    return (routed || boundary.fits({ x, y, w, h })) && canvas.fits(box) && canvas.spaced(box, AISLE * size);
  };
  const places: RegionElement[] = [];
  for (const cell of [...fill].sort(compareCells)) for (const turned of [false, true]) {
    const guard = expectPlaced(COVER_PIECE.build({ piece: 'container', turned, length: 1, offset: 0.5 }, size)), { w, h } = guard.demand.body;
    if (!clear(cell.x, cell.y, w, h)) continue;
    const [element] = placedElements(guard, 'cover-guard', cell.x, cell.y, size) as [RegionElement];
    const shapes = elementShapes(element);
    if (shapes.some(shape => shapesOverlap(shape, near)) && !shapes.some(shape => shapesOverlap(shape, disc))) places.push(element);
  }
  for (const element of rng(brief.seed, `${brief.id}:cover-near`).shuffle(places)) {
    const shapes = elementShapes(element);
    if (root && !findRegionRoute(canvas.access, [...blockers, ...shapes], root, site, site.reach ?? site.radius)) continue;
    const lootRadius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
    if (!canvas.commit({ elements: [element] })) throw new Error(`Region ${brief.id}: the canvas refused cover's guard, which its siting accepted.`);
    return { elements: [...canvas.elements],
      loot: cover.loot.filter(loot => !shapes.some(shape => shapesOverlap(shape, circle(loot.x, loot.y, lootRadius)))) };
  }
  return cover;
}
