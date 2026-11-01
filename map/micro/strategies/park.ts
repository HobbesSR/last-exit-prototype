import { rect } from '../../../shared/shape.ts';
import { PARK_TREE } from '../placeables/park-tree.ts';
import { PARK_HEDGE_RUN } from '../placeables/park-hedge-run.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, portalApproaches, sitePiecesPerCell } from './scatter.ts';
import { draw, rng } from '../random.ts';
import { createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { boxesAgainstHints } from '../hints.ts';
import { latticeSlots } from './lattice.ts';
import { createProspectiveParcels, type ProspectiveParcels } from '../prospective-parcels.ts';
import { frontStarts, growFront, portalSetback } from '../growth.ts';
import { portalStands } from '../portals.ts';
import { PARK_HEDGE_BLOCK } from '../placeables/park-hedge-block.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, Cell, RegionBrief, RegionElement } from '../types.ts';
import { builtRegion } from '../result.ts';
import { siteParkPocket } from './park-pocket.ts';

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

/**
 * Hedge fronts (#649, a measured experiment, off unless `hedgeFronts` is set): a front starts
 * at a fill edge with chance `hedgeFronts`, at least `PERIOD` cells from any front facing the
 * same way. Each grows to a seeded share of its reach, within `FRONT_DEPTH`, so fronts from
 * opposite edges can overlap and still leave the cord a way between them.
 */
const FRONT_DEPTH = { min: 0.55, max: 0.85 };
/**
 * Cells this near a portal start no front: a conservative setback (20.10), one cell rather than
 * block's two, because dense-portal parks have a three-cell portal every six cells of edge.
 */
const FRONT_SETBACK = 1;
/** The least reach worth a front: a doorway and a cell. */
const MIN_FRONT = AISLE + 1;
/**
 * Witness path segments allowed with fronts: winding cords to every stand of a many-portal park
 * pass the coordinator's default of 4,096, a tool limit rather than a contract (20.10).
 */
const FRONT_SEGMENTS = 16_384;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { phaseX: 1, phaseY: 2, hedge: 3, hedgeTurn: 4, hedgeRow: 5, hedgeGap: 6, clump: 7, count: 8, treeX: 9, treeY: 10, loot: 11,
  front: 12, frontDepth: 13 };
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
 * stay owned and clear of portal approaches. Nothing else is reserved between portals: each
 * piece commits only if a hunter cord still joins every portal stand, so pieces bend the way
 * through rather than being refused by a route fixed in the empty shape (20.10, #750).
 * A hedge's door-wide gap leaves a crossing through the run. Hinted runs guide the first
 * tree in eligible slots. When the lattice places nothing, as in a one-tile park, single trees
 * are sited cell by cell instead (#717). A region too small for a tree stays clear.
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every piece. A park sites no core elements; any the brief lists are left for the report.
 */
export function buildPark(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Park', 'density', DEFAULT_DENSITY), hedgeChance = fraction(brief, 'Park', 'hedges', DEFAULT_HEDGES);
  const frontChance = fraction(brief, 'Park', 'hedgeFronts', 0);
  const mask = createFillMask(brief), size = brief.cellSize;
  if (!mask.cells.length) return unfilledRegion(brief, CHANNEL.loot);
  // Portal approaches are the fixed anchors; the coordinator keeps a live cord witness to
  // every stand and refuses a commit that would leave none (20.10).
  const parcels = createProspectiveParcels(brief, { fixedAccess: portalApproaches(brief, 'Park'),
    ...(frontChance > 0 ? { budget: { maxSegments: FRONT_SEGMENTS } } : {}) });
  if (!parcels.ok) throw new Error(`Park region ${brief.id} cannot join its portals in its empty shape (${parcels.reason}).`);
  const canvas = parcels.coordinator;
  const pocket = hedgeChance > 0 ? siteParkPocket(brief, canvas) : { envelope: null };
  // A piece must stay owned and clear of portals; the lattice preserves inter-piece aisles.
  const clear = ({ x, y, w, h }: Box) => {
    const box = rect(x * size, y * size, w * size, h * size);
    return canvas.fits(box) && (!pocket.envelope || canvas.spaced(box));
  };

  const slots = latticeSlots(brief, mask, PERIOD, { x: CHANNEL.phaseX, y: CHANNEL.phaseY });
  const key = (x: number, y: number) => `${x},${y}`;
  const hintedTrees = new Set(boxesAgainstHints(brief, TREE, TREE).map(b => key(b.x, b.y)));

  // Siting has accepted each assembly against the canvas, so a refusal means it would leave
  // a portal without a cord. The piece is passed over; per-slot draws keep the rest unchanged.
  const place = (elements: RegionElement[]) => canvas.commit({ elements });
  const taken = new Set<string>();
  let hedges = 0, trees = 0, clumps = 0;

  // Hedge runs first: each takes its slot and the next, if both are free and its footprint fits.
  // Hedge fronts, when set, take their place.
  const grown = frontChance > 0 ? growHedgeFronts(brief, canvas, frontChance) : null;
  for (const slot of grown ? [] : slots) {
    if (taken.has(key(slot.x, slot.y)) || draw(brief.seed, slot.x, slot.y, CHANNEL.hedge) >= hedgeChance) continue;
    const across = draw(brief.seed, slot.x, slot.y, CHANNEL.hedgeTurn) < 0.5;
    const next = across ? key(slot.x + PERIOD, slot.y) : key(slot.x, slot.y + PERIOD);
    const row = Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.hedgeRow) * BAND);
    const box: Box = across ? { x: slot.x, y: slot.y + row, w: HEDGE_LENGTH, h: 1 } : { x: slot.x + row, y: slot.y, w: 1, h: HEDGE_LENGTH };
    if (taken.has(next) || !clear(box)) continue;
    // The gap leaves at least a cell of hedge each side.
    const gap = 1 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.hedgeGap) * (HEDGE_LENGTH - AISLE - 1));
    const built = expectPlaced(PARK_HEDGE_RUN.build({ length: HEDGE_LENGTH, gap, aisle: AISLE, across }, size));
    if (!place(placedElements(built, `park-hedge-${hedges + 1}`, box.x, box.y, size))) continue;
    hedges++;
    taken.add(key(slot.x, slot.y)).add(next);
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
    // A clump commits as one assembly.
    if (!place(footprints.flatMap((f, n) =>
      placedElements(expectPlaced(PARK_TREE.build({}, size)), `park-tree-${trees + n + 1}`, f.x, f.y, size)))) continue;
    trees += footprints.length;
    taken.add(key(slot.x, slot.y));
    clumps++;
  }

  // When the lattice places nothing, as in a one-tile park, single trees are sited cell by cell.
  if (!canvas.elements.length && density > 0)
    trees += sitePiecesPerCell(canvas, rng(brief.seed, `${brief.id}:park-fallback`), density, AISLE, 'park',
      () => [{ name: 'tree', place: () => expectPlaced(PARK_TREE.build({}, size)) }]);

  const elements = [...canvas.elements];
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { trees, clumps, hedges, ...(pocket.envelope ? { pockets: 1 } : {}), ...(grown ?? {}) });
}

const cellKey = (c: Cell) => `${c.x},${c.y}`;
const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

/**
 * Hedge fronts (#649): from fill edges that face out of the region, hedges one cell thick grow
 * inward through the coordinator, which admits each only as deep as a cord still joins every
 * portal stand. Ground the fronts seal off from every portal becomes hedge too (17.2.10), so no
 * unreachable open patch is left. Fronts start against the region's outside or its own clear
 * margin alike; the coordinator decides how deep each may go.
 */
function growHedgeFronts(brief: RegionBrief, canvas: ProspectiveParcels, chance: number) {
  const size = brief.cellSize, near = portalSetback(brief, FRONT_SETBACK);
  const admit = (c: Cell) => !near.has(cellKey(c)) && canvas.fits(rect(c.x * size, c.y * size, size, size));
  const taken: Cell[] = [], roots: { cell: Cell; side: number }[] = [];
  let fronts = 0;
  for (const start of frontStarts(brief, canvas.fill)) {
    const side = start.inward.y > 0 ? 0 : start.inward.x < 0 ? 1 : start.inward.y < 0 ? 2 : 3;
    if (draw(brief.seed, start.cell.x, start.cell.y, TRY(side, CHANNEL.front)) >= chance || !admit(start.cell)) continue;
    if (roots.some(r => r.side === side && Math.max(Math.abs(r.cell.x - start.cell.x), Math.abs(r.cell.y - start.cell.y)) < PERIOD)) continue;
    const share = FRONT_DEPTH.min + (FRONT_DEPTH.max - FRONT_DEPTH.min) * draw(brief.seed, start.cell.x, start.cell.y, TRY(side, CHANNEL.frontDepth));
    // A zero-attempt call measures the reach without probing.
    const reach = growFront(canvas, start.cell, start.inward, { admit, attempts: 0 }).reach;
    // A stub along the edge deflects nothing; it would only take the place of a real front.
    if (reach < MIN_FRONT) continue;
    const front = growFront(canvas, start.cell, start.inward, { admit, depth: Math.max(1, Math.round(reach * share)) });
    if (!front.handle) continue;
    const x = Math.min(...front.cells.map(c => c.x)), y = Math.min(...front.cells.map(c => c.y));
    const built = expectPlaced(PARK_HEDGE_BLOCK.build({ w: Math.max(...front.cells.map(c => c.x)) - x + 1, h: Math.max(...front.cells.map(c => c.y)) - y + 1 }, size));
    const populated = canvas.populate(front.handle, { elements: placedElements(built, `park-front-${fronts + 1}`, x, y, size) });
    if (!populated.ok) throw new Error(`Park region ${brief.id} could not populate its own front (${populated.reason}).`);
    canvas.settle(front.handle, 'populated');
    taken.push(...front.cells);
    roots.push({ cell: start.cell, side });
    fronts++;
  }
  return { fronts, frontCells: taken.length, sealedCells: fronts ? fillSealed(brief, canvas, taken) : 0 };
}

/**
 * Hedge over fill cells that no cell path from a portal stand reaches past the fronts. A body
 * needs more than a cell, so cell paths are optimistic and only certainly sealed ground is
 * filled. Each sealed patch commits as one assembly, which the coordinator still proves.
 */
function fillSealed(brief: RegionBrief, canvas: ProspectiveParcels, fronts: readonly Cell[]): number {
  const size = brief.cellSize, blocked = new Set(fronts.map(cellKey)), access = canvas.access;
  const reached = new Set<string>(), queue: Cell[] = [];
  const visit = (c: Cell) => {
    if (reached.has(cellKey(c)) || blocked.has(cellKey(c)) || !access.has(c.x, c.y)) return;
    reached.add(cellKey(c)); queue.push(c);
  };
  for (const { points } of portalStands(brief)) for (const p of points) visit({ x: Math.floor(p.x / size), y: Math.floor(p.y / size) });
  // Without a portal there is nothing to be sealed from.
  if (!reached.size) return 0;
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of SIDES) visit({ x: queue[i]!.x + dx, y: queue[i]!.y + dy });
  const sealed = canvas.fill.cells.filter(c => !reached.has(cellKey(c)) && !blocked.has(cellKey(c)));
  const left = new Set(sealed.map(cellKey));
  let filled = 0, patches = 0;
  for (const first of sealed) {
    if (!left.delete(cellKey(first))) continue;
    const patch: Cell[] = [first];
    for (let i = 0; i < patch.length; i++) for (const [dx, dy] of SIDES) {
      const n = { x: patch[i]!.x + dx, y: patch[i]!.y + dy };
      if (left.delete(cellKey(n))) patch.push(n);
    }
    // One hedge block per row run.
    const rows = patch.toSorted((a, b) => a.y - b.y || a.x - b.x), elements: RegionElement[] = [];
    for (let i = 0; i < rows.length;) {
      let j = i + 1;
      while (j < rows.length && rows[j]!.y === rows[i]!.y && rows[j]!.x === rows[j - 1]!.x + 1) j++;
      const built = expectPlaced(PARK_HEDGE_BLOCK.build({ w: j - i, h: 1 }, size));
      elements.push(...placedElements(built, `park-sealed-${patches + 1}-${elements.length + 1}`, rows[i]!.x, rows[i]!.y, size));
      i = j;
    }
    if (canvas.commit({ elements })) { filled += patch.length; patches++; }
  }
  return filled;
}
