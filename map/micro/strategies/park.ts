import { rect } from '../../../shared/shape.ts';
import { PARK_TREE } from '../placeables/park-tree.ts';
import { PARK_HEDGE_RUN } from '../placeables/park-hedge-run.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, protectedRoutes } from './scatter.ts';
import { draw } from '../random.ts';
import { createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { boxesAgainstHints } from '../hints.ts';
import { latticeSlots } from './lattice.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';
import { builtRegion } from '../result.ts';

/**
 * Clear cells between pieces and across each hedge gap: a doorway (52), so a hunter fits each.
 */
const AISLE = CELL_SCALE.doorway;
/** Cells from one slot to the next. A slot's pieces stay in its first `BAND` cells, so the rest is aisle. */
const PERIOD = 6, BAND = PERIOD - AISLE;
const DEFAULT_DENSITY = 0.6, DEFAULT_HEDGES = 0.2;
/** A tree's footprint in cells, how much of it the trunk and crown fill, and the most trees in a clump. */
const TREE = 2, CLUMP = 3;
/** A hedge run spans two slots: a slot, the aisle after it, and the next slot's band. Its thickness is in cells, centred in its row. */
const HEDGE_LENGTH = PERIOD + BAND;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { phaseX: 1, phaseY: 2, hedge: 3, hedgeTurn: 4, hedgeRow: 5, hedgeGap: 6, clump: 7, count: 8, treeX: 9, treeY: 10, loot: 11 };
/** A clump's tries: each draws its own place, so a tree dropped for overlap never shifts the next. */
const TRY = (n: number, channel: number) => channel * 8 + n;

type Box = { x: number; y: number; w: number; h: number };

/**
 * The `park` region type (54): overgrown ground. Clumps of trees give soft cover with long open
 * lines between them, and hedge runs, which block bodies but not sight (17.2.8 M34), shut off
 * stretches of ground except at a gap a door wide. It has no decomposer and no buildings.
 *
 * Slots lie on a lattice `PERIOD` cells apart at a seeded phase. With chance `hedges`, a slot
 * starts a hedge run across or down into the next slot, `HEDGE_LENGTH` cells long, in a seeded
 * row of the slot's band, with its gap at a seeded place that leaves a stub of hedge each side.
 * Each other slot holds a clump with chance `density`: up to `CLUMP` trees, round obstacles
 * `TREE` cells across, at seeded places in the slot's first `BAND` cells.
 *
 * Clumps and hedge runs keep `AISLE` clear cells from other slots. Candidate footprints
 * stay owned and clear of portal approaches; concave masks also protect a hunter corridor.
 * A hedge's door-wide gap leaves a crossing through the run. Hinted runs guide the first
 * tree in eligible slots. A region too small for a piece stays clear.
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every piece. A park sites no core elements; any the brief lists are left for the report.
 */
export function buildPark(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Park', 'density', DEFAULT_DENSITY), hedgeChance = fraction(brief, 'Park', 'hedges', DEFAULT_HEDGES);
  const mask = createFillMask(brief), size = brief.cellSize;
  if (!mask.cells.length) return unfilledRegion(brief, CHANNEL.loot);
  // Routes between portals are protected at any portal count. Past 32 portals a route from
  // the first portal to each is too dear, so a nearby-portal tree stands in: boundary
  // spacing alone let a clump or hedge seal a portal's approach (#361).
  const protectedShapes = protectedRoutes(brief, 'Park', brief.portals.length <= 32 ? 'root' : 'nearby');


  const canvas = createBuilderCanvas(brief, protectedShapes);
  // A piece must stay owned and clear of portals; the lattice preserves inter-piece aisles.
  const clear = ({ x, y, w, h }: Box) => canvas.fits(rect(x * size, y * size, w * size, h * size));

  const slots = latticeSlots(brief, mask, PERIOD, { x: CHANNEL.phaseX, y: CHANNEL.phaseY });
  const key = (x: number, y: number) => `${x},${y}`;
  const hintedTrees = new Set(boxesAgainstHints(brief, TREE, TREE).map(b => key(b.x, b.y)));

  // Siting has already accepted each assembly. A canvas refusal is a broken placement
  // invariant, rather than a new fallback that silently changes the seeded build.
  const place = (label: string, elements: RegionElement[]) => {
    if (!canvas.commit({ elements })) throw new Error(`Park placement ${label} failed its canvas commit.`);
  };
  const taken = new Set<string>();
  let hedges = 0, trees = 0, clumps = 0;

  // Hedge runs first: each takes its slot and the next, if both are free and its footprint fits.
  for (const slot of slots) {
    if (taken.has(key(slot.x, slot.y)) || draw(brief.seed, slot.x, slot.y, CHANNEL.hedge) >= hedgeChance) continue;
    const across = draw(brief.seed, slot.x, slot.y, CHANNEL.hedgeTurn) < 0.5;
    const next = across ? key(slot.x + PERIOD, slot.y) : key(slot.x, slot.y + PERIOD);
    const row = Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.hedgeRow) * BAND);
    const box: Box = across ? { x: slot.x, y: slot.y + row, w: HEDGE_LENGTH, h: 1 } : { x: slot.x + row, y: slot.y, w: 1, h: HEDGE_LENGTH };
    if (taken.has(next) || !clear(box)) continue;
    taken.add(key(slot.x, slot.y)).add(next);
    // The gap leaves at least a cell of hedge each side.
    const gap = 1 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.hedgeGap) * (HEDGE_LENGTH - AISLE - 1));
    const built = expectPlaced(PARK_HEDGE_RUN.build({ length: HEDGE_LENGTH, gap, aisle: AISLE, across }, size));
    const label = `park-hedge-${++hedges}`;
    place(label, placedElements(built, label, box.x, box.y, size));
  }

  // A clump in each other slot that rolls under `density`, if its footprint fits.
  for (const slot of slots) {
    if (taken.has(key(slot.x, slot.y)) || draw(brief.seed, slot.x, slot.y, CHANNEL.clump) >= density) continue;
    const wanted = 1 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.count) * CLUMP);
    const footprints: Box[] = [];
    for (let n = 0; n < CLUMP && footprints.length < wanted; n++) {
      const hint = n === 0 ? [...hintedTrees].map(address => address.split(',').map(Number)).find(([x, y]) =>
        x! >= slot.x && y! >= slot.y && x! + TREE <= slot.x + BAND && y! + TREE <= slot.y + BAND) : undefined;
      const x = hint?.[0] ?? slot.x + Math.floor(draw(brief.seed, slot.x, slot.y, TRY(n, CHANNEL.treeX)) * (BAND - TREE + 1));
      const y = hint?.[1] ?? slot.y + Math.floor(draw(brief.seed, slot.x, slot.y, TRY(n, CHANNEL.treeY)) * (BAND - TREE + 1));
      if (footprints.some(f => x < f.x + f.w && x + TREE > f.x && y < f.y + f.h && y + TREE > f.y)) continue;
      footprints.push({ x, y, w: TREE, h: TREE });
    }
    const x0 = Math.min(...footprints.map(f => f.x)), y0 = Math.min(...footprints.map(f => f.y));
    const box = { x: x0, y: y0, w: Math.max(...footprints.map(f => f.x + f.w)) - x0, h: Math.max(...footprints.map(f => f.y + f.h)) - y0 };
    if (!clear(box)) continue;
    taken.add(key(slot.x, slot.y));
    clumps++;
    // A clump commits as one assembly.
    place(`park-clump-${clumps}`, footprints.flatMap(f =>
      placedElements(expectPlaced(PARK_TREE.build({}, size)), `park-tree-${++trees}`, f.x, f.y, size)));
  }

  const elements = [...canvas.elements];
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { trees, clumps, hedges });
}
