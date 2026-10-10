import { buildCompound } from './compound.ts';
import { buildCover } from './cover.ts';
import { buildDepot } from './depot.ts';
import { largestRectangle } from './hall.ts';
import { buildHut } from './hut.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { buildOpen } from './open.ts';
import { buildRuins } from './ruins.ts';
import { draw } from './scatter.ts';
import { createRegionMask } from '../geometry.ts';
import { inheritBriefMargins } from '../margins.ts';
import { portalMargin } from '../hints.ts';
import { portalStands } from '../portals.ts';
import type { BuiltRegion, Cell, Portal, RegionBrief } from '../types.ts';

/**
 * Clear cells between lots. This alley width is independent of perimeter placement.
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
const LOT_TYPES: ReadonlyArray<{ type: string; build: (brief: RegionBrief, observe?: BuildingObserver) => BuiltRegion; fits: (short: number, long: number) => boolean }> = [
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
 * lists are left for the report. `observe` sees the lots' buildings, labelled as their elements are.
 */
export function buildBlock(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const plan = planBlock(brief);
  if (!plan.lots.length) return buildOpen(brief);
  const name = (child: RegionBrief) => child.id.slice(brief.id.length + 1);
  const results = [...plan.lots.map(lot => LOT_TYPES.find(t => t.type === lot.type)!.build(lot,
    observe && (trace => observe({ ...trace, label: `${name(lot)}/${trace.label}` })))), buildOpen(plan.alleys)];
  const manifest: Record<string, number> = {};
  for (const result of results) for (const [key, count] of Object.entries(result.manifest)) manifest[key] = (manifest[key] ?? 0) + count;
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
 * `MAX_LOT`. Each part tries rectangles that may attach to one or two adjacent boundary
 * sides. Hinted sides take preference. The remaining sides keep two owned cells for
 * circulation, and the parent portals stay in the alleys. A lot's type is drawn from
 * those its size suits, and two sides with standing room form its frontages.
 *
 * A convex lot may make a notch at an edge or corner, but cannot bridge opposite boundary
 * sides; its other sides keep a hunter-wide path around it. Three-cell splits separate
 * lots. Each frontage faces owned alley cells, so children keep their own promises.
 */
export function planBlock(brief: RegionBrief): BlockPlan {
  const mask = createRegionMask(brief), size = brief.cellSize;
  const x0 = Math.round(mask.bounds.x / size), y0 = Math.round(mask.bounds.y / size);
  const W = Math.round(mask.bounds.w / size), H = Math.round(mask.bounds.h / size);

  // Keep portal approaches and standing room in the circulation. Lots may reach other
  // perimeter segments; the three-cell alleys between lots are unchanged. The approach
  // stays two cells deep even though the clear margin is one: a lot attached to the
  // boundary beside a portal would otherwise leave the alley a single cell wide there.
  const margin = new Set(portalMargin({ ...brief, hints: [] }, 1).map(c => `${c.x},${c.y}`));
  for (const { portal: p, inward } of portalStands(brief)) for (let i = 0; i < p.length; i++) for (let d = 0; d < 2; d++) {
    const offset = inward.x + inward.y > 0 ? d : -1 - d;
    margin.add(p.axis === 'h' ? `${p.x + i},${p.y + offset}` : `${p.x + offset},${p.y + i}`);
  }
  const inner = (x: number, y: number, attach: readonly Side[]) => {
    // Lots allocate original ownership, including inherited clearance; their builders
    // receive the reduced fill separately. Treating clearance as missing ownership
    // would destroy every lot across an internal guaranteed tile seam.
    if (!mask.has(x, y) || margin.has(`${x},${y}`)) return false;
    for (let j = y - 2; j <= y + 2; j++) for (let i = x - 2; i <= x + 2; i++) {
      if (mask.has(i, j)) continue;
      if (!(attach.includes('N') && j < y || attach.includes('S') && j > y || attach.includes('W') && i < x || attach.includes('E') && i > x)) return false;
    }
    return true;
  };
  const hintedSide = (lot: Box, side: Side) => {
    const p = run(lot, side);
    for (let i = 0; i < p.length; i++) {
      const x = p.x + (p.axis === 'h' ? i : 0), y = p.y + (p.axis === 'v' ? i : 0);
      if (!(brief.hints ?? []).some(hint => hint.axis === p.axis && (p.axis === 'h' ? hint.y === y && x >= hint.x && x < hint.x + hint.length
        : hint.x === x && y >= hint.y && y < hint.y + hint.length))) return false;
    }
    return true;
  };
  const safeAttachment = (lot: Box) => {
    const sides = new Set((['N', 'E', 'S', 'W'] as Side[]).filter(side => !frontageFits(lot, side)));
    if (sides.has('N') && sides.has('S') || sides.has('E') && sides.has('W')) return false;
    for (let y = lot.y - 2; y < lot.y + lot.h + 2; y++) for (let x = lot.x - 2; x < lot.x + lot.w + 2; x++) {
      if (mask.has(x, y)) continue;
      if (!(sides.has('N') && y < lot.y || sides.has('S') && y >= lot.y + lot.h || sides.has('W') && x < lot.x || sides.has('E') && x >= lot.x + lot.w)) return false;
    }
    return true;
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
  const frontageFits = (lot: Box, side: Side) => {
    const p = run(lot, side);
    for (let i = 0; i < p.length; i++) for (let d = 1; d <= 2; d++) {
      const x = p.axis === 'h' ? p.x + i : p.x + (side === 'W' ? -d : d - 1);
      const y = p.axis === 'v' ? p.y + i : p.y + (side === 'N' ? -d : d - 1);
      if (!mask.has(x, y)) return false;
    }
    return true;
  };
  const corners = (lot: Box) => CORNERS.filter(corner => corner.every(side => frontageFits(lot, side)));
  const hasHintedSide = (lot: Box) => (['N', 'E', 'S', 'W'] as Side[]).some(side => hintedSide(lot, side));
  const lotForPart = (part: Box): Box | undefined => {
    const candidates = CORNERS.map(attach => largestRectangle({ cellSize: 1, bounds: part,
      has: (x, y) => inner(x, y, attach) }, MIN_LOT))
      .filter((lot): lot is Box => !!lot && safeAttachment(lot) && corners(lot).length > 0);
    candidates.sort((a, b) => Number(hasHintedSide(b)) - Number(hasHintedSide(a))
      || b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x);
    return candidates[0];
  };
  const lots = parts.map(lotForPart).filter((lot): lot is Box => !!lot)
    .sort((a, b) => a.y - b.y || a.x - b.x);

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
    const choices = corners(lot);
    const corner = choices[Math.floor(draw(brief.seed, lot.x, lot.y, CHANNEL.frontage) * choices.length)]!;
    const portals = corner.map((side): Portal => ({ id: unique(`lot-${k + 1}-${side}`), ...run(lot, side) }));
    frontages.push(...portals);
    return { id: `${brief.id}/lot-${k + 1}`, seed: childSeed(lot.x, lot.y), type, cellSize: size, cells, zones: restrict(cells), portals,
      ...(brief.hints ? { hints: inheritedHints(brief, cells) } : {}) };
  });
  const alleyCells = mask.cells.filter(c => !claimed.has(`${c.x},${c.y}`)).map(c => ({ x: c.x, y: c.y }));
  const alleys: RegionBrief = { id: `${brief.id}/alleys`, seed: childSeed(x0, y0), type: 'open', cellSize: size, cells: alleyCells,
    zones: restrict(alleyCells), portals: [...structuredClone(brief.portals), ...frontages.map(portal => ({ ...portal }))],
    ...(brief.hints ? { hints: inheritedHints(brief, alleyCells) } : {}) };
  // Margin cells remain owned by lots/alleys. They are constraints, not extra children.
  // Only genuinely new frontages add clearance; inherited exclusions are never inset again.
  const constrained = inheritBriefMargins(brief, [...children, alleys]);
  return { lots: constrained.slice(0, children.length), alleys: constrained[children.length]! };
}

/** Clip the parent's hinted segments to the child owning its inside cell. */
function inheritedHints(parent: RegionBrief, cells: Cell[]): NonNullable<RegionBrief['hints']> {
  const parentCells = new Set(parent.cells.map(c => `${c.x},${c.y}`)), owned = new Set(cells.map(c => `${c.x},${c.y}`));
  const hints: NonNullable<RegionBrief['hints']> = [];
  for (const hint of parent.hints ?? []) {
    let start = -1;
    for (let i = 0; i <= hint.length; i++) {
      const x = hint.axis === 'h' ? hint.x + i : hint.x, y = hint.axis === 'v' ? hint.y + i : hint.y;
      const before = hint.axis === 'h' ? `${x},${y - 1}` : `${x - 1},${y}`, after = `${x},${y}`;
      const key = parentCells.has(before) ? before : after;
      const keep = i < hint.length && owned.has(key);
      if (keep && start < 0) start = i;
      if (!keep && start >= 0) {
        hints.push({ axis: hint.axis, x: hint.x + (hint.axis === 'h' ? start : 0), y: hint.y + (hint.axis === 'v' ? start : 0), length: i - start });
        start = -1;
      }
    }
  }
  return hints;
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
