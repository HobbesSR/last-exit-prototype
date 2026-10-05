import { circle, rect } from '../../../shared/shape.ts';
import { cellLoot, draw, fraction } from './scatter.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

/**
 * Clear cells around every piece's box, from every other piece and from any cell the region
 * doesn't own, and the width of the gap in a hedge run: a doorway (52), so a hunter fits each.
 */
const AISLE = CELL_SCALE.doorway;
/** Cells from one slot to the next. A slot's pieces stay in its first `BAND` cells, so the rest is aisle. */
const PERIOD = 6, BAND = PERIOD - AISLE;
const DEFAULT_DENSITY = 0.6, DEFAULT_HEDGES = 0.2;
/** A tree's footprint in cells, how much of it the trunk and crown fill, and the most trees in a clump. */
const TREE = 2, TREE_REACH = 0.75, CLUMP = 3;
/** A hedge run spans two slots: a slot, the aisle after it, and the next slot's band. Its thickness is in cells, centred in its row. */
const HEDGE_LENGTH = PERIOD + BAND, HEDGE_THICK = 0.4;

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
 * Every clump's box, which is convex, and every hedge run's keeps `AISLE` clear cells from every
 * other's and from any cell the region doesn't own. Such boxes can't divide the ground a hunter
 * can reach outside them, where every portal is, and a hedge's gap only adds ground inside its
 * ring. So, like `cover`, the region keeps the portal promise exactly when its shape does, with
 * no route search. A region too small for a piece stays clear.
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every piece. A park sites no core elements; any the brief lists are left for the report.
 */
export function buildPark(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Park', 'density', DEFAULT_DENSITY), hedgeChance = fraction(brief, 'Park', 'hedges', DEFAULT_HEDGES);
  const mask = createRegionMask(brief), size = brief.cellSize;

  // Every cell of a box and its ring of AISLE cells is owned.
  const clear = ({ x, y, w, h }: Box) => {
    for (let j = y - AISLE; j < y + h + AISLE; j++) for (let i = x - AISLE; i < x + w + AISLE; i++) if (!mask.has(i, j)) return false;
    return true;
  };

  // Slot origins over the mask's bounds, in row order, so nothing depends on the brief's cell order.
  const phase = { x: Math.floor(draw(brief.seed, 0, 0, CHANNEL.phaseX) * PERIOD), y: Math.floor(draw(brief.seed, 0, 0, CHANNEL.phaseY) * PERIOD) };
  const span = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const { x, y } of mask.cells) Object.assign(span, { x0: Math.min(span.x0, x), y0: Math.min(span.y0, y), x1: Math.max(span.x1, x), y1: Math.max(span.y1, y) });
  const first = (min: number, offset: number) => offset + Math.floor((min - offset) / PERIOD) * PERIOD;
  const slots: { x: number; y: number }[] = [];
  for (let y = first(span.y0, phase.y); y <= span.y1; y += PERIOD)
    for (let x = first(span.x0, phase.x); x <= span.x1; x += PERIOD) slots.push({ x, y });
  const key = (x: number, y: number) => `${x},${y}`;

  const elements: RegionElement[] = [];
  const taken = new Set<string>();
  let hedges = 0, trees = 0, clumps = 0;

  // Hedge runs first: each takes its slot and the next, if both are free and the run keeps its ring.
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
    const stubs: [number, number][] = [[0, gap], [gap + AISLE, HEDGE_LENGTH]];
    const parts = stubs.map(([s, e]) => ({ part: 'obstacle' as const, kind: 'hedge' as const,
      shape: across ? rect(s * size, Math.round((0.5 - HEDGE_THICK / 2) * size), (e - s) * size, Math.round(HEDGE_THICK * size))
        : rect(Math.round((0.5 - HEDGE_THICK / 2) * size), s * size, Math.round(HEDGE_THICK * size), (e - s) * size) }));
    elements.push({ label: `park-hedge-${++hedges}`, x: box.x * size, y: box.y * size, template: { w: box.w * size, h: box.h * size, parts } });
  }

  // A clump in each other slot that rolls under `density`, if its box keeps its ring.
  for (const slot of slots) {
    if (taken.has(key(slot.x, slot.y)) || draw(brief.seed, slot.x, slot.y, CHANNEL.clump) >= density) continue;
    const wanted = 1 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.count) * CLUMP);
    const footprints: Box[] = [];
    for (let n = 0; n < CLUMP && footprints.length < wanted; n++) {
      const x = slot.x + Math.floor(draw(brief.seed, slot.x, slot.y, TRY(n, CHANNEL.treeX)) * (BAND - TREE + 1));
      const y = slot.y + Math.floor(draw(brief.seed, slot.x, slot.y, TRY(n, CHANNEL.treeY)) * (BAND - TREE + 1));
      if (footprints.some(f => x < f.x + f.w && x + TREE > f.x && y < f.y + f.h && y + TREE > f.y)) continue;
      footprints.push({ x, y, w: TREE, h: TREE });
    }
    const x0 = Math.min(...footprints.map(f => f.x)), y0 = Math.min(...footprints.map(f => f.y));
    const box = { x: x0, y: y0, w: Math.max(...footprints.map(f => f.x + f.w)) - x0, h: Math.max(...footprints.map(f => f.y + f.h)) - y0 };
    if (!clear(box)) continue;
    taken.add(key(slot.x, slot.y));
    clumps++;
    for (const f of footprints) {
      const middle = TREE * size / 2;
      elements.push({ label: `park-tree-${++trees}`, x: f.x * size, y: f.y * size,
        template: { w: TREE * size, h: TREE * size, parts: [{ part: 'obstacle', kind: 'tree', shape: circle(middle, middle, Math.round(TREE_REACH * size)) }] } });
    }
  }

  const parts = elements.flatMap(element => element.template.parts);
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, mask, pieces, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: 0, loot: loot.length, coreElements: 0, trees, clumps, hedges } };
}
