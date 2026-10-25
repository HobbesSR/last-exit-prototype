import { rect, transform } from '../../../shared/shape.ts';
import { construct } from '../../../shared/shape-construction.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { largestRectangle } from './hall.ts';
import { WAREHOUSE } from '../placeables/warehouse.ts';
import { PLANT_MACHINE } from '../placeables/plant-machine.ts';
import { PLANT_PIPE_RUN } from '../placeables/plant-pipe-run.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, protectedRoutes } from './scatter.ts';
import { draw } from '../random.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { boundaryBoxFilter, boxesAgainstHints } from '../hints.ts';
import { latticeSlots } from './lattice.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { builtRegion } from '../result.ts';

/** The catalogue's proposed shape need (54), as `depot`'s: a contained square at least this many cells a side. */
const MIN_SIDE = 10;
/**
 * Clear cells between pieces and across every pipe gap: a doorway (52), so a hunter fits each.
 */
const AISLE = CELL_SCALE.doorway;
/** Cells from one slot to the next. A slot's pieces stay in its first `BAND` cells, so the rest is aisle. */
const PERIOD = 8, BAND = PERIOD - AISLE;
const DEFAULT_DENSITY = 0.6, DEFAULT_SHED = 0.5;
/** A machine's sides in cells, and how far its body stands inside them. */
const MACHINE_MIN = 2, MACHINE_MAX = 4;
/** How much of a machine's corner a chamfer cuts, in cells, and the chance a machine has one. */
const CHAMFERED = 0.5;
/** The chance two neighbouring machines are joined, and a pipe's thickness in cells, centred in its row. */
const JOINED = 0.7;
/** How far a pipe run's stubs reach into the machines it joins, in cells, before they are cut back to the machines' surfaces. */
const SEAT = 0.5;
/** The shed's size in slots: two by one, one by two, or two by two. */
const SHEDS: ReadonlyArray<readonly [number, number]> = [[2, 1], [1, 2], [2, 2]];

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { phaseX: 1, phaseY: 2, machine: 3, width: 4, height: 5, jitterX: 6, jitterY: 7, chamfer: 8,
  loot: 9, shed: 10, shedOrder: 11, shedSize: 12, design: 13 };
/** A pipe run's draws, keyed by the slot it leaves, one set for each direction. */
const RUN_CHANNEL = { across: { joined: 14, row: 15, gap: 16 }, down: { joined: 17, row: 18, gap: 19 } };

type Box = { x: number; y: number; w: number; h: number };

/**
 * The `plant` region type (54): an industrial works. Machinery stands as large convex blocks on
 * a coarse grid, giving hard cover with long lines between machines and tight corners where
 * pipe runs meet them. It has no decomposer.
 *
 * Slots lie on a lattice `PERIOD` cells apart at a seeded phase. With chance `shed`, a roofed
 * shed takes a block of two or four slots, at the first block in a seeded order that fits; it is
 * a building design (56), built as `depot`'s warehouse is. Each other slot holds a machine with
 * chance `density`: a block 2 to 4 cells a side, some with chamfered corners, at a seeded place
 * in the slot's first `BAND` cells. Neighbouring machines across or down are joined, with chance
 * `JOINED`, by a pipe run along a row both face. A pipe blocks movement but not sight, as a
 * window does (17.2.8 M34), and leaves one gap a door wide, `AISLE` cells, at a seeded place.
 *
 * Machines and the shed keep `AISLE` clear cells from other pieces. Pipe runs bridge
 * neighbouring machines through a door-wide gap, with owned aisles around each run. Each stub is
 * its run less both machines' shapes, broken into convex pieces, so it ends on the machine's
 * surface, chamfer included, rather than inside it (#490). Candidate footprints stay clear of
 * portal approaches; concave masks also protect a hunter corridor. Pieces commit through the
 * builder canvas (20.2), whose siting queries they were accepted with, so a refusal is a defect.
 * A region with no contained `MIN_SIDE` square goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every piece, indoors or out. A plant sites no core elements; any the brief lists are left for
 * the report. `observe`, when given, sees the shed's design as `depot` reports its warehouses.
 */
export function buildPlant(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const density = fraction(brief, 'Plant', 'density', DEFAULT_DENSITY);
  const shedChance = fraction(brief, 'Plant', 'shed', DEFAULT_SHED);
  const mask = createFillMask(brief), accessMask = createAccessMask(brief), size = brief.cellSize;
  if (!mask.cells.length) return unfilledRegion(brief, CHANNEL.loot);
  // Eligibility is the original area's; the boxes themselves must fit the reduced fill (20.6).
  if (!largestRectangle(createRegionMask(brief), MIN_SIDE)) return unfilledRegion(brief, CHANNEL.loot);
  // Routes between portals are protected; past 32 portals that search is too dear, and
  // boxes keep an aisle from the boundary instead.
  const boundary = boundaryBoxFilter(brief, AISLE), routed = brief.portals.length <= 32;
  const canvas = createBuilderCanvas(brief, routed ? protectedRoutes(brief, 'Plant') : []);

  // A piece must stay owned, clear of portals and an aisle from other pieces.
  const clear = (box: Box) => {
    const shape = rect(box.x * size, box.y * size, box.w * size, box.h * size);
    return canvas.fits(shape) && (routed || boundary.fits(box)) && canvas.spaced(shape, AISLE * size);
  };
  // Siting has already accepted these with the canvas's own queries; a refusal is a defect.
  const commit = (label: string, assembly: Parameters<typeof canvas.commit>[0]) => {
    if (!canvas.commit(assembly)) throw new Error(`Plant placement ${label} failed its canvas commit.`);
  };

  const slots = latticeSlots(brief, mask, PERIOD, { x: CHANNEL.phaseX, y: CHANNEL.phaseY });
  const key = (x: number, y: number) => `${x},${y}`;

  // The shed, at the first block of slots in a seeded order whose box fits.
  const shedSlots = new Set<string>();
  let sheds = 0, designed = 0;
  if (draw(brief.seed, 0, 0, CHANNEL.shed) < shedChance) {
    const [across, down] = SHEDS[Math.floor(draw(brief.seed, 0, 0, CHANNEL.shedSize) * SHEDS.length)]!;
    const box = (slot: { x: number; y: number }): Box => ({ x: slot.x, y: slot.y, w: across * PERIOD - AISLE, h: down * PERIOD - AISLE });
    const hintedSheds = new Set(boxesAgainstHints(brief, across * PERIOD - AISLE, down * PERIOD - AISLE).map(b => key(b.x, b.y)));
    const site = slots.map(slot => ({ slot, order: draw(brief.seed, slot.x, slot.y, CHANNEL.shedOrder), hinted: hintedSheds.has(key(slot.x, slot.y)) }))
      .sort((a, b) => Number(b.hinted) - Number(a.hinted) || a.order - b.order || a.slot.y - b.slot.y || a.slot.x - b.slot.x).find(({ slot }) => clear(box(slot)));
    if (site) {
      const shed = box(site.slot), label = 'plant-shed-1';
      for (let j = 0; j < down; j++) for (let i = 0; i < across; i++) shedSlots.add(key(site.slot.x + i * PERIOD, site.slot.y + j * PERIOD));
      const seed = Math.floor(draw(brief.seed, shed.x, shed.y, CHANNEL.design) * 2 ** 31);
      const built = expectPlaced(WAREHOUSE.build({ w: shed.w, h: shed.h, alongX: shed.w >= shed.h, seed }, size)), { design, allocation, realization, rejected } = built.details;
      if (design.spaces.length > 1) designed++;
      observe?.({ label, origin: { x: shed.x * size, y: shed.y * size }, cellSize: size, design, allocation, realization, ...rejected.length ? { rejected } : {} });
      commit(label, { elements: placedElements(built, label, shed.x, shed.y, size) });
      sheds = 1;
    }
  }

  // A machine in each slot that rolls under `density`, if its footprint fits.
  const machines = new Map<string, Box>(), machineShapes = new Map<string, Shape[]>();
  const hintedMachines = new Map<string, ReturnType<typeof boxesAgainstHints>>();
  for (const slot of slots) {
    if (shedSlots.has(key(slot.x, slot.y)) || draw(brief.seed, slot.x, slot.y, CHANNEL.machine) >= density) continue;
    const side = (channel: number) => MACHINE_MIN + Math.floor(draw(brief.seed, slot.x, slot.y, channel) * (MACHINE_MAX - MACHINE_MIN + 1));
    const w = side(CHANNEL.width), h = side(CHANNEL.height);
    const hintKey = `${w},${h}`;
    if (!hintedMachines.has(hintKey)) hintedMachines.set(hintKey, boxesAgainstHints(brief, w, h));
    const hint = hintedMachines.get(hintKey)!.find(candidate => candidate.x >= slot.x && candidate.y >= slot.y
      && candidate.x + w <= slot.x + BAND && candidate.y + h <= slot.y + BAND);
    const box = { x: hint?.x ?? slot.x + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.jitterX) * (BAND - w + 1)),
      y: hint?.y ?? slot.y + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.jitterY) * (BAND - h + 1)), w, h };
    if (!clear(box)) continue;
    machines.set(key(slot.x, slot.y), box);
    const chamfered = draw(brief.seed, slot.x, slot.y, CHANNEL.chamfer) < CHAMFERED;
    const built = expectPlaced(PLANT_MACHINE.build({ w, h, chamfered }, size)), label = `plant-machine-${machines.size}`;
    const placed = placedElements(built, label, box.x, box.y, size);
    machineShapes.set(key(slot.x, slot.y), placed.flatMap(element => elementShapes(element)));
    commit(label, { elements: placed });
  }

  // Pipe runs between neighbouring machines, across then down, each with one door-wide gap.
  let pipes = 0;
  for (const slot of slots) {
    const a = machines.get(key(slot.x, slot.y));
    if (!a) continue;
    for (const across of [true, false]) {
      const bKey = across ? key(slot.x + PERIOD, slot.y) : key(slot.x, slot.y + PERIOD), b = machines.get(bKey);
      if (!b) continue;
      // Along u from a's far face to b's near face, in a row v that both span.
      const [u0, u1] = across ? [a.x + a.w, b.x] : [a.y + a.h, b.y];
      const [v0, v1] = across ? [Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h)] : [Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w)];
      const length = u1 - u0, channel = RUN_CHANNEL[across ? 'across' : 'down'];
      const roll = (name: keyof typeof channel) => draw(brief.seed, slot.x, slot.y, channel[name]);
      if (v1 <= v0 || length < AISLE + 1 || roll('joined') >= JOINED) continue;
      const v = v0 + Math.floor(roll('row') * (v1 - v0)), gap = Math.floor(roll('gap') * (length - AISLE + 1));
      const run: Box = across ? { x: u0, y: v, w: length, h: 1 } : { x: v, y: u0, w: 1, h: length };
      // Keep full owned aisles around pipes so each door-wide gap opens on both sides.
      let runRing = true;
      for (let y = Math.floor(run.y) - AISLE; y < Math.ceil(run.y + run.h) + AISLE; y++)
        for (let x = Math.floor(run.x) - AISLE; x < Math.ceil(run.x + run.w) + AISLE; x++)
          if (!accessMask.has(x, y)) runRing = false;
      if (!runRing) continue;
      // Local to the run's box, which reaches SEAT into each machine.
      const built = expectPlaced(PLANT_PIPE_RUN.build({ length, gap, aisle: AISLE, across }, size));
      const seated = across ? { ...run, x: run.x - SEAT, w: run.w + 2 * SEAT } : { ...run, y: run.y - SEAT, h: run.h + 2 * SEAT };
      const [element] = placedElements(built, `plant-pipe-${pipes + 1}`, seated.x, seated.y, size);
      // Each stub less both machines, so it ends on their surfaces, as convex pieces local to the element.
      const ends = [...machineShapes.get(key(slot.x, slot.y))!, ...machineShapes.get(bKey)!];
      const pieces = element!.template.parts.flatMap(part => part.part === 'obstacle'
        ? construct([transform(part.shape, element!.x, element!.y)]).subtract(ends).pieces() : []);
      if (!pieces.length || pieces.some(piece => !canvas.fits(piece))) continue;
      const parts = pieces.map(piece => ({ part: 'obstacle' as const, kind: 'pipe' as const, shape: transform(piece, -element!.x, -element!.y) }));
      // It addresses each stub's cells, flush with its machines' boxes; the gap is left as the aisle it is.
      const areas = [[0, gap], [gap + AISLE, length]].filter(([s, e]) => e > s).map(([s, e]) => across
        ? rect((run.x + s) * size, run.y * size, (e - s) * size, size) : rect(run.x * size, (run.y + s) * size, size, (e - s) * size));
      commit(element!.label, { elements: [{ ...element!, template: { ...element!.template, parts } }], areas, extents: areas });
      pipes++;
    }
  }

  const elements = [...canvas.elements];
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { machines: machines.size, pipes, sheds, designed });
}
