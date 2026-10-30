import type { Side } from '../port-terms.ts';
import { largestRectangle } from './hall.ts';
import { cellLoot } from './scatter.ts';
import { draw } from '../random.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { boxesAgainstHints } from '../hints.ts';
import { portalStands } from '../portals.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { COMPOUND_RING } from '../placeables/compound-ring.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';
import { COVER_EXECUTION, previewedCoverExecution } from './cover.ts';
import type { PatchOffer } from '../delegation.ts';
import { delegateYardCandidates, yardDiagnostics } from '../yard-handoff.ts';
import type { YardDiagnostics } from '../yard-handoff.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { executeDelegation, flattenDelegationResult } from '../delegation-execute.ts';
import type { ExecutionContext, ExecutionOptions, ExecutionRegistry } from '../delegation-execute.ts';
import { builtRegion } from '../result.ts';
import { buildCompoundCourt } from './compound-court.ts';

/** The catalogue's proposed shape need (54): the compound at least this many cells a side, so its court is at least 4. */
const MIN_SIDE = 10;
/** The compound's sides are capped, so an enormous region holds one compound in a wide yard. */
const MAX_SIDE = 24;
/** How deep the ring of rooms is, in cells: a hunter fits inside, between quarter-cell walls. */
const DEPTH = 3;
const MIN_ROOM = 3;
const MIN_GATES = 1, MAX_GATES = 4, DEFAULT_GATES = 2;
/** Measured optional-adoption capacity, not the SDK portal limit. */
const MAX_HANDOFF_PORTALS = 128;
/** A gate's passage through the ring: a doorway (52). */
const PASSAGE = CELL_SCALE.doorway;

const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];

/** Per-side draw channels, so no choice shifts another. */
const CHANNEL = { offset: 1, gateSide: 2, gateAt: 3, loot: 5 };

/** A box in the compound's own cells. */
interface Box { x: number; y: number; w: number; h: number }

/** Read-only evidence from the production probe order; never selects extra sites. */
export interface CompoundSitingProbe {
  box: Box;
  reason: 'outside-fill' | 'insufficient-gate-stands' | 'invalid-start' | 'disconnected-portals' | 'unreachable-gates' | 'accepted';
  gateSides?: Side[];
  missingEntrances?: { x: number; y: number }[];
  reachedBlocks?: number;
}

/** The builder's siting: validate gates, find the ring space, then search it. */
function locateCompound(brief: RegionBrief, observe?: (probe: CompoundSitingProbe) => void) {
  const gates = brief.parameters?.gates ?? DEFAULT_GATES;
  if (typeof gates !== 'number' || !Number.isInteger(gates) || gates < MIN_GATES || gates > MAX_GATES)
    throw new RangeError(`Compound gates must be a whole number from ${MIN_GATES} to ${MAX_GATES}.`);
  const fill = createFillMask(brief), space = largestRectangle(fill, MIN_SIDE);
  const site = space ? siteCompound(brief, fill, createAccessMask(brief), space, gates, observe) : undefined;
  return { gates, space, site };
}

/** Diagnose the exact bounded search without building or changing its policy. */
export function diagnoseCompoundSiting(brief: RegionBrief) {
  const probes: CompoundSitingProbe[] = [];
  const { gates, space, site } = locateCompound(brief, probe => probes.push(probe));
  return { space: space ?? null, gates, probes, site: site ? { ...site, gated: [...site.gated] } : null };
}

/** Whole-cell yard stands at an outer door center, measured along the ring box. */
function gateYardStands(box: Box, side: Side, along: number): { x: number; y: number }[] {
  return [...new Set([Math.floor(along), Math.ceil(along)])].map(t => ({
    x: side === 'W' ? box.x - 2 : side === 'E' ? box.x + box.w : box.x + t,
    y: side === 'N' ? box.y - 2 : side === 'S' ? box.y + box.h : box.y + t,
  }));
}

/** Keep the yard's portal blocks joined and leave a reachable doorstep at each chosen gate. */
function siteCompound(brief: RegionBrief, mask: ReturnType<typeof createRegionMask>, accessMask: ReturnType<typeof createRegionMask>, space: Box, gates: number,
  observe?: (probe: CompoundSitingProbe) => void):
  (Box & { gated: Set<Side> }) | undefined {
  const key = (x: number, y: number) => `${x},${y}`;
  const entrances: { x: number; y: number }[] = [];
  // Each entrance block straddles its portal's seam, in the clear margin on both sides (20.6).
  for (const { portal: { axis, x, y, length } } of portalStands(brief)) {
    for (let i = 0; i + 2 <= length; i++) {
      entrances.push(axis === 'h' ? { x: x + i, y: y - 1 } : { x: x - 1, y: y + i });
    }
  }
  const gateOrder = [...SIDES].map((side, i) => ({ side, order: draw(brief.seed, i, 0, CHANNEL.gateSide) }))
    .sort((a, b) => a.order - b.order).map(v => v.side);
  const sizes: [number, number][] = [];
  // Keep as much of the designed ring as the yard allows. Each step removes one cell
  // from each side, enough to open a new hunter-width route without exhaustive sizes.
  for (let w = Math.min(space.w, MAX_SIDE), h = Math.min(space.h, MAX_SIDE);
    w >= MIN_SIDE && h >= MIN_SIDE; w -= 2, h -= 2) sizes.push([w, h]);
  if (!sizes.some(([w, h]) => w === MIN_SIDE && h === MIN_SIDE)) sizes.push([MIN_SIDE, MIN_SIDE]);
  for (const [w, h] of sizes) {
    if (w < MIN_SIDE || h < MIN_SIDE) continue;
    const seen = new Set<string>(), sites: Box[] = [];
    const add = (x: number, y: number) => {
      if (seen.has(key(x, y))) return;
      seen.add(key(x, y)); sites.push({ x, y, w, h });
    };
    // Hints take priority. A few deterministic interior positions cover a large field without
    // searching every placement; a small yard can afford its complete set of positions.
    const hinted = boxesAgainstHints(brief, w, h)
      .sort((a, b) => draw(brief.seed, a.x, a.y, CHANNEL.offset) - draw(brief.seed, b.x, b.y, CHANNEL.offset))
      .slice(0, 16);
    for (const b of hinted) add(b.x, b.y);
    const nx = space.w - w + 1, ny = space.h - h + 1;
    add(space.x + Math.floor((nx - 1) / 2), space.y + Math.floor((ny - 1) / 2));
    const preferred = sites.length;
    if (nx <= 20 && ny <= 20) {
      for (let y = space.y; y < space.y + ny; y++) for (let x = space.x; x < space.x + nx; x++) add(x, y);
    } else {
      for (let i = 0; i < 12; i++) add(space.x + Math.floor(draw(brief.seed, i, 0, CHANNEL.offset) * nx),
        space.y + Math.floor(draw(brief.seed, i, 1, CHANNEL.offset) * ny));
    }
    // Limit probes on a small yard too; the centered site and the hinted sites
    // precede the seeded alternatives.
    if (nx <= 20 && ny <= 20) {
      sites.splice(preferred, sites.length - preferred, ...sites.slice(preferred).sort((a, b) =>
        draw(brief.seed, a.x, a.y, CHANNEL.offset) - draw(brief.seed, b.x, b.y, CHANNEL.offset)));
      sites.length = Math.min(sites.length, preferred + 64);
    }
    for (const box of sites) {
      const inside = (x: number, y: number) => x >= box.x && x < box.x + w && y >= box.y && y < box.y + h;
      let valid = true;
      for (let y = box.y; y < box.y + h && valid; y++) for (let x = box.x; x < box.x + w; x++)
        if (!mask.has(x, y)) { valid = false; break; }
      if (!valid) { observe?.({ box, reason: 'outside-fill' }); continue; }
      const fits = (x: number, y: number) => !inside(x, y) && !inside(x + 1, y) && !inside(x, y + 1) && !inside(x + 1, y + 1)
        && accessMask.has(x, y) && accessMask.has(x + 1, y) && accessMask.has(x, y + 1) && accessMask.has(x + 1, y + 1);
      // A gate needs a two-cell yard stand at its actual passage. Reject sites
      // without enough such sides before walking the yard, the costly check.
      const gateSteps = gateOrder.map(side => {
        const middle = (side === 'N' || side === 'S' ? w : h) - 2 * DEPTH;
        let a = Math.floor(draw(brief.seed, SIDES.indexOf(side), 1, CHANNEL.gateAt) * (middle - PASSAGE + 1));
        let b = a + PASSAGE;
        if (a < MIN_ROOM) a = 0;
        if (middle - b < MIN_ROOM) b = middle;
        const steps: string[] = [];
        // The realized outer door is centered in this passage. A stand
        // elsewhere in a widened passage is not evidence for that door's
        // actual yard access, especially beside a concave ownership corner.
        for (const { x, y } of gateYardStands(box, side, DEPTH + (a + b) / 2 - 1)) {
          if (!fits(x, y)) return { side, steps: [] };
          steps.push(key(x, y));
        }
        return { side, steps };
      }).filter(v => v.steps.length);
      if (gateSteps.length < gates) { observe?.({ box, reason: 'insufficient-gate-stands', gateSides: gateSteps.map(v => v.side) }); continue; }
      const start = entrances[0] ?? accessMask.cells.find(c => fits(c.x, c.y));
      if (!start || !fits(start.x, start.y)) { observe?.({ box, reason: 'invalid-start' }); continue; }
      // This flood belongs only to this candidate box: each node is an owned 2x2
      // hunter stand outside it, and adjacent nodes sweep an owned 2x3 rectangle.
      // Sharing that reached set among portals and gate steps is safe while the box
      // is fixed; the next candidate recomputes it instead of reusing yard evidence.
      const reached = new Set([key(start.x, start.y)]), queue = [start];
      for (let head = 0; head < queue.length; head++) {
        const { x, y } = queue[head]!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy, k = key(nx, ny);
          if (reached.has(k) || !fits(nx, ny)) continue;
          reached.add(k); queue.push({ x: nx, y: ny });
        }
      }
      if (entrances.some(e => !reached.has(key(e.x, e.y)))) {
        observe?.({ box, reason: 'disconnected-portals', gateSides: gateSteps.map(v => v.side), reachedBlocks: reached.size,
          missingEntrances: entrances.filter(e => !reached.has(key(e.x, e.y))) });
        continue;
      }
      const accessible = gateSteps.filter(v => v.steps.some(step => reached.has(step))).map(v => v.side);
      if (accessible.length >= gates) {
        observe?.({ box, reason: 'accepted', gateSides: accessible, reachedBlocks: reached.size });
        return { ...box, gated: new Set(accessible.slice(0, gates)) };
      }
      observe?.({ box, reason: 'unreachable-gates', gateSides: accessible, reachedBlocks: reached.size });
    }
  }
  return undefined;
}

/**
 * The `compound` region type (54): rooms in a ring around a walled court, with a few gates.
 * A pocket that rewards a contestant who knows its gates and traps one who doesn't. It has no
 * decomposer.
 *
 * One compound stands in a contained rectangle, capped at `MAX_SIDE`, with a connected yard
 * and accessible gates. Its outer edge is the back wall of a ring of roofed
 * rooms `DEPTH` cells deep, with a square room at each corner. Each side's rooms open
 * onto the court. Each corner room opens only into its neighbour along the north or south
 * side, a room or a passage, so it is a dead end. `gates` sides, drawn from the seed, have a passage through the ring from a gate
 * in the outer wall to the court.
 *
 * The ring is one building design (56 L5): its rooms and passages are spaces over the ring's
 * cells, and the layout above is their allocation, since `allocateBuilding`'s guillotine search
 * can't partition a ring. Walls between spaces are built once. A passage is kept clear, so the
 * walls it shares stand in the rooms and it stays a doorway wide, and it lies open to the court
 * along its whole length. `splitBuilding` makes each space its own element, and each room its
 * own roof. Rooms one can walk between without leaving the ring fade together
 * (`reachableRoofGroups`), which joins only a corner room and its neighbour. `observe`, when given, sees the ring's design as one `BuildingTrace`, `compound`.
 *
 * Candidate boxes lie in the reduced fill, off every portal's clear margin, and are checked
 * against the hunter's yard blocks.
 * A region with no usable box of `MIN_SIDE` takes terminal empty (20.7).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every wall and door, in the rooms, the court or the yard. A compound sites no core elements;
 * any the brief lists are left for the report.
 */
export function buildCompound(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const node = buildCompoundGeneration(brief, observe ? { observe } : {});
  const result = flattenDelegationResult(node);
  // These counters describe the retained ring, rather than cover geometry.
  return { ...result, brief, manifest: { ...result.manifest,
    ...(node.retained.manifest.rooms === undefined ? {} : { rooms: node.retained.manifest.rooms }),
    ...(node.retained.manifest.compoundGates === undefined ? {} : { compoundGates: node.retained.manifest.compoundGates }) } };
}

/** Detached observations of the optional yard delegation attempt. */
export type CompoundYardDiagnostics = YardDiagnostics<'no-space' | 'no-site' | 'portal-capacity'>;
export interface CompoundExecutionOptions extends ExecutionOptions {
  observeYard?: (diagnostics: CompoundYardDiagnostics) => void;
}
/** Owning inputs, decisions and results for versioned recovery (20.7). */
export function buildCompoundGeneration(brief: RegionBrief, options: CompoundExecutionOptions = {}) {
  const { observeYard, ...executionOptions } = options;
  return executeDelegation(brief, { ...COMPOUND_EXECUTION_REGISTRY,
    compound: { ...COMPOUND_EXECUTION_REGISTRY.compound!, build: (b, c, observe) => buildRetainedCompound(b, c, observe, observeYard) },
    cover: previewedCoverExecution() }, executionOptions);
}

export const COMPOUND_EXECUTION_REGISTRY: ExecutionRegistry = Object.freeze({
  compound: { version: 'compound-yard-5', build: buildRetainedCompound },
  cover: COVER_EXECUTION,
});

function buildRetainedCompound(brief: RegionBrief, context: ExecutionContext, observe?: BuildingObserver, observeYard?: CompoundExecutionOptions['observeYard']): BuiltRegion {
  const size = brief.cellSize;
  const { space, site } = locateCompound(brief);
  if (!space) { observeYard?.(yardDiagnostics(brief.id, 'no-space')); return context.empty('compound has no usable ring box'); }
  if (!site) { observeYard?.(yardDiagnostics(brief.id, 'no-site')); return context.empty('compound has no ring with reachable yard gates'); }
  const { x: bx, y: by, w: W, h: H, gated } = site;

  const gatedBits = SIDES.reduce((bits, side, i) => bits | (gated.has(side) ? 1 << i : 0), 0);
  const ring = expectPlaced(COMPOUND_RING.build({ w: W, h: H, gates: gatedBits, seed: brief.seed }, size));
  const { design, allocation, realization, rooms, passages } = ring.details;
  // The placeable gives local roof-group suffixes; the builder scopes them to this region.
  for (const element of ring.elements) for (const roof of element.template.roofs ?? [])
    if (roof.groupId) roof.groupId = brief.id + roof.groupId;
  observe?.({ label: 'compound', origin: { x: bx * size, y: by * size }, cellSize: size, design, allocation, realization });
  const elements = placedElements(ring, 'compound', bx, by, size);
  // Siting has already accepted this box. A canvas refusal is a broken placement invariant.
  if (!createBuilderCanvas(brief).commit({ elements })) throw new Error('Compound placement failed its canvas commit.');
  elements.push(...buildCompoundCourt(brief, site, observe));
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const steps = ring.details.steps.map(step => ({ x: bx + step.x, y: by + step.y }));
  delegateYard(brief, site, steps, elements, context, observeYard);
  brief = context.brief;
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { rooms, compoundGates: passages.length });
}

/** Try a capped number of yard boxes, allowing the coordinator to move yard cords. */
function delegateYard(brief: RegionBrief, site: Box, steps: { x: number; y: number }[], elements: RegionElement[], context: ExecutionContext, observe?: CompoundExecutionOptions['observeYard']): void {
  // Optional compound adoption is bounded separately from the SDK. The measured
  // 170-portal witness exhausted initialization without any child; avoid paying
  // for that known unsupported scale. Authored sample inputs stay below 128.
  if (brief.portals.length > MAX_HANDOFF_PORTALS) {
    const diagnostics = yardDiagnostics<'no-space' | 'no-site' | 'portal-capacity'>(brief.id, 'portal-capacity');
    diagnostics.reason = `compound handoffs support at most ${MAX_HANDOFF_PORTALS} original portals`;
    observe?.(diagnostics);
    return;
  }
  delegateYardCandidates<'no-space' | 'no-site' | 'portal-capacity'>(brief, context, {
    retainedBoxes: [site], steps: steps.map(({ x, y }) => [x, y]), elements, label: 'compound',
    offersFor: (reserved, diagnostics) => yardOffers(brief, reserved, diagnostics), observe,
  });
}

/**
 * Partition actual unreserved yard into up to eight maximal rectangles. Try each
 * whole hunk before one-cell circulation insets and smaller side slabs. This is
 * compound authorship, not a shared SDK shape or perimeter requirement. Greedy
 * extraction/acceptance is bounded and deterministic, not an area optimum.
 */
function yardOffers(brief: RegionBrief, reserved: Set<string>, diagnostics: CompoundYardDiagnostics): PatchOffer[] {
  const owned = createRegionMask(brief), fill = createFillMask(brief);
  const remaining = new Set(owned.cells.filter(c => !reserved.has(`${c.x},${c.y}`)).map(c => `${c.x},${c.y}`));
  const seen = new Set<string>(), offers: PatchOffer[] = [];
  for (let iteration = 0; iteration < 8; iteration++) {
    const box = largestRectangle({ ...owned, has: (x, y) => remaining.has(`${x},${y}`) }, 3);
    if (!box) break;
    const { x, y, w, h } = box, boxes: Box[] = [box];
    // An inset gives the retained parent room to circulate beside a large
    // child. It is a candidate alternative, not a frozen perimeter collar.
    if (w >= 5 && h >= 5) boxes.push({ x: x + 1, y: y + 1, w: w - 2, h: h - 2 });
    if (w >= 5) boxes.push({ x: x + 1, y, w: w - 2, h });
    if (h >= 5) boxes.push({ x, y: y + 1, w, h: h - 2 });
    for (const ratio of [0.75, 0.5]) {
      const sw = Math.max(3, Math.floor(w * ratio)), sh = Math.max(3, Math.floor(h * ratio));
      boxes.push({ x, y, w: sw, h }, { x: x + w - sw, y, w: sw, h },
        { x, y, w, h: sh }, { x, y: y + h - sh, w, h: sh });
    }
    // Discovery partitions the yard independently of admission. Refused cells
    // remain owned; alternatives overlap only inside this same discovered box.
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) remaining.delete(`${i},${j}`);
    for (const candidate of boxes) {
      const { x, y, w, h } = candidate, id = `${x},${y},${w},${h}`;
      if (seen.has(id)) continue;
      seen.add(id); diagnostics.considered++;
      const cells = [];
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) cells.push({ x: i, y: j });
      const hasFillPocket = cells.some(c => [0, 1, 2].every(dy => [0, 1, 2].every(dx =>
        c.x + dx < x + w && c.y + dy < y + h && fill.has(c.x + dx, c.y + dy))));
      if (!hasFillPocket) { diagnostics.filtered++; continue; }
      offers.push({ key: `yard:${id}`, cells, type: 'cover', reasonTags: ['unused-exterior-yard'] });
      if (offers.length === 48) return offers;
    }
  }
  return offers;
}
