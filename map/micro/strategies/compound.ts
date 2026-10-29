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
import { createProspectiveParcels } from '../prospective-parcels.ts';
import { rect } from '../../../shared/shape.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { executeDelegation, flattenDelegationResult } from '../delegation-execute.ts';
import type { ExecutionContext, ExecutionOptions, ExecutionRegistry } from '../delegation-execute.ts';
import { builtRegion } from '../result.ts';

const BODY = 2;
/** The catalogue's proposed shape need (54): the compound at least this many cells a side, so its court is at least 4. */
const MIN_SIDE = 10;
/** The compound's sides are capped, so an enormous region holds one compound in a wide yard. */
const MAX_SIDE = 24;
/** How deep the ring of rooms is, in cells: a hunter fits inside, between quarter-cell walls. */
const DEPTH = 3;
const MIN_ROOM = 3;
const MIN_GATES = 1, MAX_GATES = 4, DEFAULT_GATES = 2;
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
export interface CompoundYardDiagnostics {
  briefId: string;
  outcome: 'no-space' | 'no-site' | 'no-eligible-candidates' | 'init' | 'claim' | 'populate' | 'settle' | 'all-refused' | 'delegated';
  reason?: string;
  considered: number;
  filtered: number;
  probed: number;
  accepted: number;
  refusals: Record<string, number>;
  eligibleOffers: PatchOffer[];
  probes: Array<{ key: string; verdict: 'accepted' | 'refused'; reason?: string }>;
}
export interface CompoundExecutionOptions extends ExecutionOptions {
  observeYard?: (diagnostics: CompoundYardDiagnostics) => void;
}
const yardDiagnostics = (briefId: string, outcome: CompoundYardDiagnostics['outcome']): CompoundYardDiagnostics =>
  ({ briefId, outcome, considered: 0, filtered: 0, probed: 0, accepted: 0, refusals: {}, eligibleOffers: [], probes: [] });

/** Owning inputs, decisions and results for versioned recovery (20.7). */
export function buildCompoundGeneration(brief: RegionBrief, options: CompoundExecutionOptions = {}) {
  const { observeYard, ...executionOptions } = options;
  return executeDelegation(brief, { ...COMPOUND_EXECUTION_REGISTRY,
    compound: { ...COMPOUND_EXECUTION_REGISTRY.compound!, build: (b, c, observe) => buildRetainedCompound(b, c, observe, observeYard) },
    cover: previewedCoverExecution() }, executionOptions);
}

export const COMPOUND_EXECUTION_REGISTRY: ExecutionRegistry = Object.freeze({
  compound: { version: 'compound-yard-3', build: buildRetainedCompound },
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
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const steps = ring.details.steps.map(step => ({ x: bx + step.x, y: by + step.y }));
  delegateYard(brief, site, steps, elements, context, observeYard);
  brief = context.brief;
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { rooms, compoundGates: passages.length });
}

/** Try a capped number of yard boxes, allowing the coordinator to move yard cords. */
function delegateYard(brief: RegionBrief, site: Box, steps: { x: number; y: number }[], elements: RegionElement[], context: ExecutionContext, observe?: CompoundExecutionOptions['observeYard']): void {
  const diagnostics = yardDiagnostics(brief.id, 'no-eligible-candidates');
  const report = (outcome: CompoundYardDiagnostics['outcome'], reason?: string) => {
    diagnostics.outcome = outcome;
    if (reason !== undefined) diagnostics.reason = reason;
    observe?.(structuredClone(diagnostics));
  };
  const size = brief.cellSize, { w, h } = site;
  const stands = steps.map(({ x, y }) => [x, y] as [number, number]);
  // The retained-portal policy requires each original portal's owned seam
  // cells to stay with the parent. These checks are necessary refusals, so
  // discard them before constructing the optional routing coordinator.
  const reserved = new Set<string>();
  for (let y = site.y; y < site.y + h; y++) for (let x = site.x; x < site.x + w; x++) reserved.add(`${x},${y}`);
  for (const [x, y] of stands) for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) reserved.add(`${i},${j}`);
  const owned = createRegionMask(brief);
  for (const p of brief.portals) for (let i = 0; i < p.length; i++) {
    const before = p.axis === 'h' ? { x: p.x + i, y: p.y - 1 } : { x: p.x - 1, y: p.y + i };
    const after = p.axis === 'h' ? { x: p.x + i, y: p.y } : { x: p.x, y: p.y + i };
    const cell = owned.has(before.x, before.y) ? before : after;
    reserved.add(`${cell.x},${cell.y}`);
  }
  const offers = yardOffers(brief, reserved, diagnostics);
  diagnostics.eligibleOffers = offers;
  if (!offers.length) { report('no-eligible-candidates'); return; }
  const fixedAccess = stands.map(([x, y]) => rect(x * size, y * size, BODY * size, BODY * size));
  const terminals = stands.map(([x, y]) => ({ x: (x + BODY / 2) * size, y: (y + BODY / 2) * size }));
  const created = createProspectiveParcels(brief, { handoff: context, fixedAccess, terminals });
  // An independently sited ring remains valid when the optional continuous search cannot prove it.
  if (!created.ok) { report('init', created.reason); return; }
  const coordinator = created.coordinator;
  const claim = coordinator.tryClaim([rect(site.x * size, site.y * size, w * size, h * size)]);
  if (!claim.ok) { report('claim', claim.reason); return; }
  const populated = coordinator.populate(claim.handle, { elements });
  if (!populated.ok) { report('populate', populated.reason); return; }
  const settled = coordinator.settle(claim.handle, 'populated');
  if (!settled.ok) { report('settle', settled.reason); return; }

  let accepted = false;
  const transferred = new Set<string>();
  for (const offer of offers) {
    if (offer.cells.some(c => transferred.has(`${c.x},${c.y}`))) continue;
    diagnostics.probed++;
    const proposal = coordinator.probeHandoff([offer], { externalPortals: 'retained' });
    if (!proposal.ok) {
      diagnostics.probes.push({ key: offer.key, verdict: 'refused', reason: proposal.reason });
      diagnostics.refusals[proposal.reason] = (diagnostics.refusals[proposal.reason] ?? 0) + 1;
      continue;
    }
    const acceptance = coordinator.acceptHandoff(proposal.proposal);
    if (acceptance.ok) {
      accepted = true;
      diagnostics.accepted++;
      diagnostics.probes.push({ key: offer.key, verdict: 'accepted' });
      for (const c of offer.cells) transferred.add(`${c.x},${c.y}`);
    } else {
      diagnostics.probes.push({ key: offer.key, verdict: 'refused', reason: acceptance.reason });
      diagnostics.refusals[acceptance.reason] = (diagnostics.refusals[acceptance.reason] ?? 0) + 1;
    }
  }
  if (accepted && !coordinator.executeHandoffs().ok) throw new Error('Verified compound handoff could not execute.');
  report(accepted ? 'delegated' : 'all-refused');
}

/**
 * Peripheral candidates start flush against each extent corner or edge. Several
 * scales allow a smaller useful box when a larger lobe meets a portal or ring.
 * Require a complete owned rectangle and at least a 3-by-3 pocket for cover;
 * refusals and narrow remnants remain with the compound. The fixed candidate cap
 * limits the number of expensive probes, not their cost: preparation and routing
 * still grow with region geometry and the accepted batch.
 */
function yardOffers(brief: RegionBrief, reserved: Set<string>, diagnostics: CompoundYardDiagnostics): PatchOffer[] {
  const owned = createRegionMask(brief), fill = createFillMask(brief), cells = owned.cells;
  const minX = Math.min(...cells.map(c => c.x)), maxX = Math.max(...cells.map(c => c.x));
  const minY = Math.min(...cells.map(c => c.y)), maxY = Math.max(...cells.map(c => c.y));
  const width = maxX - minX + 1, height = maxY - minY + 1;
  const dims = (n: number) => [...new Set([Math.floor(n / 2), Math.floor(n / 3), 3].filter(v => v >= 3))];
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  // Interleave corner boxes and centered slabs at each scale so the cap
  // leaves both kinds available even on broad regions.
  for (const w of dims(width)) for (const h of dims(height)) {
    for (const x of [minX, maxX - w + 1]) for (const y of [minY, maxY - h + 1]) boxes.push({ x, y, w, h });
    boxes.push({ x: minX + Math.floor((width - w) / 2), y: minY, w, h },
      { x: minX + Math.floor((width - w) / 2), y: maxY - h + 1, w, h },
      { x: minX, y: minY + Math.floor((height - h) / 2), w, h },
      { x: maxX - w + 1, y: minY + Math.floor((height - h) / 2), w, h });
  }
  // Explicit interior patches follow the peripheral sequence, at quarter-grid positions.
  const boundaryCount = boxes.length;
  for (const w of [6, 3].filter(n => n < width)) for (const h of [6, 3].filter(n => n < height))
    for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.25, 0.5, 0.75])
      boxes.push({ x: minX + Math.floor((width - w) * fx), y: minY + Math.floor((height - h) * fy), w, h });
  const seen = new Set<string>(), offers: PatchOffer[] = [];
  let boundaryEligible = 0, interiorEligible = 0;
  for (const [index, { x, y, w, h }] of boxes.entries()) {
    const boundary = index < boundaryCount;
    if (boundary ? boundaryEligible >= 36 : interiorEligible >= 12) continue;
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
    const hasFillPocket = patch.some(c => [0, 1, 2].every(dy => [0, 1, 2].every(dx =>
      c.x + dx < x + w && c.y + dy < y + h && fill.has(c.x + dx, c.y + dy))));
    if (!hasFillPocket || patch.some(c => reserved.has(`${c.x},${c.y}`))) { diagnostics.filtered++; continue; }
    offers.push({ key: `yard:${id}`, cells: patch, type: 'cover', reasonTags: ['unused-exterior-yard'] });
    if (boundary) boundaryEligible++; else interiorEligible++;
  }
  return offers;
}
