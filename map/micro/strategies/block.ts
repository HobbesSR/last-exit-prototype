import { cellKey, compareCells } from '../../kernel/cell.ts';
import { unusedComponents } from '../components.ts';
import { allocateCandidates } from '../decomposition/allocation.ts';
import { REGION_CELL_LIMIT, REGION_SPAN_LIMIT } from '../decomposition/analysis.ts';
import { createRegionContext, REGION_CELL_SIZE_LIMIT } from '../decomposition/context.ts';
import type { CandidatePiece, DecompositionPlan } from '../decomposition/types.ts';
import { buildCompound } from './compound.ts';
import { buildCover } from './cover.ts';
import { buildDepot } from './depot.ts';
import { largestRectangle } from './hall.ts';
import { buildHut } from './hut.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { buildOpen } from './open.ts';
import { buildRuins } from './ruins.ts';
import { draw } from '../random.ts';
import { createRegionMask } from '../geometry.ts';
import { dispatchDelegationPartition, flattenDelegationPartition } from '../delegation-execute.ts';
import { inheritBriefMargins } from '../margins.ts';
import { clipHints, portalMargin } from '../hints.ts';
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
export interface BlockPlan { lots: RegionBrief[]; alleys: RegionBrief; allocation?: DecompositionPlan }

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
 * `open` whole (17 M24). A bounded SDK fallback tries one smaller lot when the
 * ordinary split selects none (20.3.5).
 *
 * The children's geometry, loot and manifest counts are gathered into one result, with each
 * element's label prefixed by its child's. A block sites no core elements; any the brief
 * lists are left for the report. `observe` sees the lots' buildings, labelled as their elements are.
 */
export function buildBlock(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const plan = planBlock(brief);
  if (!plan.lots.length) return buildOpen(brief);
  const registry = Object.fromEntries(LOT_TYPES.map(({ type, build }) => [type,
    { version: 'block-child-1', build: (child: RegionBrief, _context: unknown, childObserve?: BuildingObserver) => build(child, childObserve) }]));
  registry.open = { version: 'block-child-1', build: (child: RegionBrief) => buildOpen(child) };
  const result = flattenDelegationPartition(dispatchDelegationPartition(brief, [...plan.lots, plan.alleys], registry, observe ? { observe } : {}));
  return { ...result, brief: structuredClone(brief) };
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
  const candidatesFor = (part: Box): Box[] => {
    const candidates = CORNERS.map(attach => largestRectangle({ cellSize: 1, bounds: part,
      has: (x, y) => inner(x, y, attach) }, MIN_LOT))
      .filter((lot): lot is Box => !!lot && safeAttachment(lot) && corners(lot).length > 0);
    candidates.sort((a, b) => Number(hasHintedSide(b)) - Number(hasHintedSide(a))
      || b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x);
    return candidates;
  };
  // A lot may not cut the alleys in two. On a concave mask, a side the lot attaches to
  // can be boundary for only part of its length, and the lot would then wall off the
  // circulation beyond it. The alleys are one `open` child and must keep their own
  // promise, so each part takes its best candidate that leaves them one area, or none.
  const chosen = new Set<string>();
  const keepsAlleys = (lot: Box) => {
    const kept = new Set(chosen);
    for (let y = lot.y; y < lot.y + lot.h; y++) for (let x = lot.x; x < lot.x + lot.w; x++) kept.add(cellKey({ x, y }));
    return unusedComponents(mask.cells, kept).length === 1;
  };
  // Row order, so lots are chosen and numbered alike whatever order the split ran in.
  const lots: Box[] = [];
  for (const part of [...parts].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const lot = candidatesFor(part).find(keepsAlleys);
    if (!lot) continue;
    lots.push(lot);
    for (let y = lot.y; y < lot.y + lot.h; y++) for (let x = lot.x; x < lot.x + lot.w; x++) chosen.add(cellKey({ x, y }));
  }
  lots.sort((a, b) => a.y - b.y || a.x - b.x);

  // Bounded production pilot (20.3.5): a maximal rectangle may sever a concave
  // alley even when a smaller lot fits. Successful guillotine plans are retained.
  // One claim makes residual connectivity a hard, candidate-local predicate.
  let allocation: DecompositionPlan | undefined;
  if (!lots.length && mask.cells.length <= REGION_CELL_LIMIT && W <= REGION_SPAN_LIMIT && H <= REGION_SPAN_LIMIT
    && size > 0 && size <= REGION_CELL_SIZE_LIMIT) {
    const candidates: CandidatePiece[] = [], boxes = new Map<string, Box>();
    const cellsOf = (box: Box): Cell[] => {
      const cells: Cell[] = [];
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) cells.push({ x, y });
      return cells;
    };
    // Stable row order and largest size first; cap admitted candidates, not
    // coordinates, so narrow leading tendrils do not consume the whole budget.
    scan: for (const cell of [...mask.cells].sort(compareCells)) for (const side of [12, 9, 6]) {
      const box = { x: cell.x, y: cell.y, w: side, h: side };
      const cells = cellsOf(box);
      if (cells.some(c => !mask.has(c.x, c.y) || margin.has(cellKey(c)))
        || !safeAttachment(box) || !corners(box).length || !keepsAlleys(box)) continue;
      const id = `fallback-${String(candidates.length).padStart(2, '0')}`;
      boxes.set(id, box);
      candidates.push({ id, cells, role: 'lot', rationale: 'Smaller lot with two full frontages and one connected circulation remainder.' });
      if (candidates.length === 64) break scan;
    }
    // Portal approaches remain residual circulation. Reserving them separately
    // would split that ownership into artificial reserved children in the SDK.
    const context = createRegionContext({ id: 'block-fallback', cells: [...mask.cells], cellSize: size });
    allocation = allocateCandidates(context, candidates, [{ id: 'block-lot', roles: ['lot'], tags: [],
      minArea: 36, maxArea: 144, holes: 'none', rectangular: true,
      utility: a => ({ lotArea: a.area }) }], {
      beamWidth: 1, maxPieces: 1, maxCandidates: 64, unusedCellPenalty: 0,
      residualComponentPenalty: 0, smallResidualPenalty: 0, smallResidualArea: 0,
      piecePenalty: 0, seamRunPenalty: 0, portalWidth: 2,
    }, { strategy: 'block-single-lot-fallback' });
    for (const piece of allocation.pieces) lots.push(boxes.get(piece.id)!);
  }

  const taken = new Set(brief.portals.map(portal => portal.id));
  const unique = (id: string) => { while (taken.has(id)) id += '+'; taken.add(id); return id; };
  const restrict = (cells: Cell[]): RegionBrief['zones'] => {
    const keys = new Set(cells.map(c => `${c.x},${c.y}`));
    return brief.zones.map(zone => ({ ...zone, cells: zone.cells.filter(c => keys.has(`${c.x},${c.y}`)).sort(compareCells) }))
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
      ...(brief.hints ? { hints: clipHints(brief.hints, brief.cells, cells) } : {}) };
  });
  const alleyCells = mask.cells.filter(c => !claimed.has(`${c.x},${c.y}`)).map(c => ({ x: c.x, y: c.y }));
  const alleys: RegionBrief = { id: `${brief.id}/alleys`, seed: childSeed(x0, y0), type: 'open', cellSize: size, cells: alleyCells,
    zones: restrict(alleyCells), portals: [...structuredClone(brief.portals), ...frontages.map(portal => ({ ...portal }))],
    ...(brief.hints ? { hints: clipHints(brief.hints, brief.cells, alleyCells) } : {}) };
  // Margin cells remain owned by lots/alleys. They are constraints, not extra children.
  // Only genuinely new frontages add clearance; inherited exclusions are never inset again.
  const constrained = inheritBriefMargins(brief, [...children, alleys]);
  return { lots: constrained.slice(0, children.length), alleys: constrained[children.length]!, ...(allocation ? { allocation } : {}) };
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
