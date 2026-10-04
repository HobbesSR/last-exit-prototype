import { buildCompound } from './compound.ts';
import { buildCover } from './cover.ts';
import { buildDepot } from './depot.ts';
import { largestRectangle } from './hall.ts';
import { buildHut } from './hut.ts';
import { buildOpen } from './open.ts';
import { buildRuins } from './ruins.ts';
import { draw } from './scatter.ts';
import { createRegionMask } from '../geometry.ts';
import type { BuiltRegion, Cell, Portal, RegionBrief } from '../types.ts';

/**
 * Clear cells around every lot, to any cell the region doesn't own and to the next lot, as
 * `depot` once kept around a warehouse. It is the block's own alley width (54), a doorway and
 * a cell, and stays 3 where `depot`'s aisle is a doorway.
 */
const AISLE = 3;
/** A lot's least side: `hut`'s region (54). */
const MIN_LOT = 6;
/** A part of the split longer than this on either axis is split again. */
const MAX_LOT = 24;

/** Per-place draw channels, so no choice shifts another. */
const CHANNEL = { split: 1, type: 2, frontage: 3, seed: 4 };

type Box = { x: number; y: number; w: number; h: number };
type Side = 'N' | 'E' | 'S' | 'W';
/** A lot's frontages: the two sides at one of its corners. */
const CORNERS: ReadonlyArray<readonly [Side, Side]> = [['N', 'W'], ['N', 'E'], ['S', 'E'], ['S', 'W']];

/** The types a lot may hold, and the lots each suits, by its shorter and longer sides (54's shape needs). */
const LOT_TYPES: ReadonlyArray<{ type: string; build: (brief: RegionBrief) => BuiltRegion; fits: (short: number, long: number) => boolean }> = [
  { type: 'hut', build: buildHut, fits: (_, long) => long <= 12 },
  { type: 'depot', build: buildDepot, fits: short => short >= 10 },
  { type: 'compound', build: buildCompound, fits: short => short >= 16 },
  { type: 'ruins', build: buildRuins, fits: () => true },
  { type: 'cover', build: buildCover, fits: short => short >= 9 },
];

/** The block's children: briefs for its lots, and its alleys, which hold every one of the block's own portals. */
export interface BlockPlan { lots: RegionBrief[]; alleys: RegionBrief }

/**
 * The `block` region type (54): a city block of lots and the alleys between them. It is the
 * catalogue's first decomposer. Its children are built by other types' strategies (19).
 *
 * `planBlock` splits the region. Each lot is a `hut`, `depot`, `compound`, `ruins` or
 * `cover` region with two portals, its frontages onto the alleys. Two, not one, so the lot is
 * a passage its strategy must keep joined rather than a pocket that owes nothing (54, "How
 * many portals a region has"). The alleys are one `open` region holding every portal of the
 * block's own and every lot's frontages. Each child keeps its own promise, so the block's
 * portals are joined by inference (51 stage 6). A region with no room for a lot is left
 * `open` whole (17 M24).
 *
 * The children's geometry, loot and manifest counts are gathered into one result, with each
 * element's label prefixed by its child's. A block sites no core elements; any the brief
 * lists are left for the report.
 */
export function buildBlock(brief: RegionBrief): BuiltRegion {
  const plan = planBlock(brief);
  if (!plan.lots.length) return buildOpen(brief);
  const results = [...plan.lots.map(lot => LOT_TYPES.find(t => t.type === lot.type)!.build(lot)), buildOpen(plan.alleys)];
  const manifest: Record<string, number> = {};
  for (const result of results) for (const [key, count] of Object.entries(result.manifest)) manifest[key] = (manifest[key] ?? 0) + count;
  const name = (child: RegionBrief) => child.id.slice(brief.id.length + 1);
  return { version: 'region-2', brief: structuredClone(brief),
    elements: results.flatMap(result => result.elements.map(element => ({ ...element, label: `${name(result.brief)}/${element.label}` }))),
    coreElements: [], loot: results.flatMap(result => result.loot),
    manifest: { ...manifest, cells: brief.cells.length, coreElements: 0, lots: plan.lots.length } };
}

/**
 * Split a block's region into lots and alleys (54 `block`).
 *
 * The region's bounding box is split, guillotine fashion, across its longer side at a seeded
 * place, leaving an alley `AISLE` cells wide between the parts, until no part is longer than
 * `MAX_LOT`. In each part, the lot is the largest rectangle, at least `MIN_LOT` a side, of cells
 * with `AISLE` owned cells all round them. So every lot keeps `AISLE` clear cells from any cell
 * the region doesn't own and from every other lot, and every portal of the block's own lies on
 * the alleys. A lot's type is drawn from those its size suits, and its frontages are the two
 * sides at a seeded corner, so a `hut` fits in the far corner of the smallest lot.
 *
 * Why that keeps the promise: a lot is a convex box with a clear ring wider than a hunter
 * around it, in the alleys, so the lots can't divide the alleys, as `depot`'s pieces can't
 * divide its yard. The alleys keep the block's portals joined exactly when the block's shape
 * does. Each lot touches only the alleys, through its frontages, so every two children that
 * share a boundary have a portal between them.
 */
export function planBlock(brief: RegionBrief): BlockPlan {
  const mask = createRegionMask(brief), size = brief.cellSize;
  const x0 = Math.round(mask.bounds.x / size), y0 = Math.round(mask.bounds.y / size);
  const W = Math.round(mask.bounds.w / size), H = Math.round(mask.bounds.h / size);

  // Owned cells in each window, by a prefix sum, to find the cells with AISLE owned cells all round.
  const sums = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    sums[(y + 1) * (W + 1) + x + 1] = (mask.has(x0 + x, y0 + y) ? 1 : 0) + sums[y * (W + 1) + x + 1]! + sums[(y + 1) * (W + 1) + x]! - sums[y * (W + 1) + x]!;
  const side = 2 * AISLE + 1;
  const inner = (x: number, y: number) => {
    const ax = x - x0 - AISLE, ay = y - y0 - AISLE, bx = ax + side, by = ay + side;
    if (ax < 0 || ay < 0 || bx > W || by > H) return false;
    return sums[by * (W + 1) + bx]! - sums[ay * (W + 1) + bx]! - sums[by * (W + 1) + ax]! + sums[ay * (W + 1) + ax]! === side * side;
  };

  const parts: Box[] = [], pending: Box[] = [{ x: x0, y: y0, w: W, h: H }];
  while (pending.length) {
    const box = pending.pop()!, across = box.w >= box.h, length = across ? box.w : box.h;
    if (length <= MAX_LOT) { parts.push(box); continue; }
    // The first part's length, leaving at least a lot's length on each side of the alley.
    const room = length - AISLE - 2 * MIN_LOT;
    const cut = MIN_LOT + Math.floor(draw(brief.seed, box.x * 1024 + box.w, box.y * 1024 + box.h, CHANNEL.split) * (room + 1));
    pending.push(across ? { ...box, w: cut } : { ...box, h: cut },
      across ? { ...box, x: box.x + cut + AISLE, w: box.w - cut - AISLE } : { ...box, y: box.y + cut + AISLE, h: box.h - cut - AISLE });
  }
  // Row order, so lots are numbered alike whatever order the split ran in.
  const lots = parts.map(part => largestRectangle({ cellSize: 1, bounds: part, has: inner }, MIN_LOT))
    .filter((lot): lot is Box => !!lot).sort((a, b) => a.y - b.y || a.x - b.x);

  const taken = new Set(brief.portals.map(portal => portal.id));
  const unique = (id: string) => { while (taken.has(id)) id += '+'; taken.add(id); return id; };
  const restrict = (cells: Cell[]): RegionBrief['zones'] => {
    const keys = new Set(cells.map(c => `${c.x},${c.y}`));
    return brief.zones.map(zone => ({ ...zone, cells: zone.cells.filter(c => keys.has(`${c.x},${c.y}`)).sort((a, b) => a.y - b.y || a.x - b.x) }))
      .filter(zone => zone.cells.length);
  };
  const childSeed = (x: number, y: number) => Math.floor(draw(brief.seed, x, y, CHANNEL.seed) * 0x7fffffff);

  const claimed = new Set<string>(), frontages: Portal[] = [];
  const children = lots.map((lot, k): RegionBrief => {
    const cells: Cell[] = [];
    for (let y = lot.y; y < lot.y + lot.h; y++) for (let x = lot.x; x < lot.x + lot.w; x++) { cells.push({ x, y }); claimed.add(`${x},${y}`); }
    const short = Math.min(lot.w, lot.h), long = Math.max(lot.w, lot.h), suited = LOT_TYPES.filter(t => t.fits(short, long));
    const type = suited[Math.floor(draw(brief.seed, lot.x, lot.y, CHANNEL.type) * suited.length)]!.type;
    const corner = CORNERS[Math.floor(draw(brief.seed, lot.x, lot.y, CHANNEL.frontage) * CORNERS.length)]!;
    const portals = corner.map((side): Portal => ({ id: unique(`lot-${k + 1}-${side}`), ...run(lot, side) }));
    frontages.push(...portals);
    return { id: `${brief.id}/lot-${k + 1}`, seed: childSeed(lot.x, lot.y), type, cellSize: size, cells, zones: restrict(cells), portals };
  });
  const alleyCells = mask.cells.filter(c => !claimed.has(`${c.x},${c.y}`)).map(c => ({ x: c.x, y: c.y }));
  return { lots: children, alleys: { id: `${brief.id}/alleys`, seed: childSeed(x0, y0), type: 'open', cellSize: size, cells: alleyCells,
    zones: restrict(alleyCells), portals: [...structuredClone(brief.portals), ...frontages.map(portal => ({ ...portal }))] } };
}

/** The run along one whole side of a box, in cells. */
function run(box: Box, side: Side): Omit<Portal, 'id'> {
  switch (side) {
    case 'N': return { axis: 'h', x: box.x, y: box.y, length: box.w };
    case 'S': return { axis: 'h', x: box.x, y: box.y + box.h, length: box.w };
    case 'W': return { axis: 'v', x: box.x, y: box.y, length: box.h };
    case 'E': return { axis: 'v', x: box.x + box.w, y: box.y, length: box.h };
  }
}
