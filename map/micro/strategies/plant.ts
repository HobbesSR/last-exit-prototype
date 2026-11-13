import { rect, transform } from '../../../shared/shape.ts';
import { construct } from '../../../shared/shape-construction.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { largestRectangle } from './hall.ts';
import { WAREHOUSE } from '../placeables/warehouse.ts';
import { PLANT_MACHINE } from '../placeables/plant-machine.ts';
import { PLANT_PIPE_RUN } from '../placeables/plant-pipe-run.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, portalApproaches } from './scatter.ts';
import { draw, rng } from '../random.ts';
import type { BuildingAppearance, ObstacleAppearance } from '../../../shared/types.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { createBuilderCanvas, type BuilderCanvas, type CanvasAssembly, type SitingCanvas } from '../canvas.ts';
import { createProspectiveParcels } from '../prospective-parcels.ts';
import { SCATTER_CORD_BUDGET } from '../cord-witness.ts';
import { boundaryBoxFilter, boxesAgainstHints } from '../hints.ts';
import { latticeSlots } from './lattice.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { builtRegion } from '../result.ts';
import { infillCrates as placeInfillCrates } from './infill.ts';

/** The catalogue's proposed shape need (54), as `depot`'s: a contained square at least this many cells a side. */
const MIN_SIDE = 10;
/**
 * Clear cells between pieces and across every pipe gap: a doorway (52), so a hunter fits each.
 */
const AISLE = CELL_SCALE.doorway;
/** Cells from one slot to the next. A slot's pieces stay in its first `BAND` cells, so the rest is aisle. */
const PERIOD = 8, BAND = PERIOD - AISLE;
const DEFAULT_DENSITY = 0.6, DEFAULT_SHED = 0.5;
/** The most portals a live cord joins; past this, boxes keep an aisle from the boundary instead. */
const ROUTED = 32;

/** The least and most cells a machine's side takes. */
const MACHINE_MIN = 2, MACHINE_MAX = 4;
/** The chance a machine has chamfered corners. */
const CHAMFERED = 0.5;
/** The chance two neighbouring machines are joined by a pipe run. */
const JOINED = 0.7;
/** How far a pipe run's stubs reach into the machines it joins, in cells, before they are cut back to the machines' surfaces. */
const SEAT = 0.5;
/** The shed's size in slots: two by one, one by two, or two by two. */
const SHEDS: ReadonlyArray<readonly [number, number]> = [[2, 1], [1, 2], [2, 2]];

/**
 * Authored minimal appearance descriptors for plant industrial sheds and machinery (11.1 §5.5, 41.2 Step 5).
 */
export const PLANT_SHED_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'concrete',
  wallMaterial: 'metal',
  roofPaint: 'slateShadow',
  roofRim: 'sodiumAmber',
  interiorTrim: 'oxidizedMetal',
  roofSign: {
    color: 'oxidizedMetal',
    backing: 'structuralVoid',
    stripe: 'sodiumAmber',
    dx: 28,
    dy: 16,
    w: 90,
    h: 22,
  },
  neglect: {
    roofDrainStain: { dx: 80, dy: 30, w: 40, h: 26 },
    floorStain: { dx: 60, dy: 50, w: 44, h: 28 },
    scorchMark: { dx: 40, dy: 60, w: 46, h: 30 },
  },
});

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { phaseX: 1, phaseY: 2, machine: 3, width: 4, height: 5, jitterX: 6, jitterY: 7, chamfer: 8,
  loot: 9, shed: 10, shedOrder: 11, shedSize: 12, design: 13,
  infill: 20, infillLength: 21, infillOffset: 22 };
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
 * portal approaches. Up to `ROUTED` portals, nothing else is reserved between them: pieces commit
 * through a prospective-parcels coordinator (20.10), which refuses one that would leave no hunter
 * cord to every portal stand, and a refused piece is passed over (#759). Machines, pipes and crates
 * are each sited on a draft and the cord proved once for as many as stand together (#787). Past that, boxes keep an
 * aisle from the boundary instead, and pieces commit through the builder canvas (20.2), whose
 * siting queries they were accepted with, so a refusal there is a defect.
 * A region with no contained `MIN_SIDE` square goes to `open` (17 M24).
 * Residual machinery bands then receive crates, preserving skipped/shed slots, aisles and a local hunter bypass (20.3.4).
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
  // Up to `ROUTED` portals, a live cord joins them (20.10); past that, keeping it is too dear,
  // and boxes keep an aisle from the boundary instead.
  const boundary = boundaryBoxFilter(brief, AISLE), routed = brief.portals.length <= ROUTED;
  const parcels = routed ? createProspectiveParcels(brief, { fixedAccess: portalApproaches(brief, 'Plant'),
    budget: SCATTER_CORD_BUDGET }) : null;
  if (parcels && !parcels.ok) throw new Error(`Plant region ${brief.id} cannot join its portals in its empty shape (${parcels.reason}).`);
  const coordinator = parcels?.coordinator, canvas: SitingCanvas = coordinator ?? createBuilderCanvas(brief);
  // Machines, pipes and crates are each sited on a draft, and the cord proved once for as many as
  // stand together (`stage`, #787). Unrouted, a phase commits directly and keeps everything.
  const phase = () => coordinator ? coordinator.stage() : { canvas: canvas as BuilderCanvas, flush: () => null };

  // A piece must stay owned, clear of portals and an aisle from other pieces.
  const clear = (on: SitingCanvas, box: Box) => {
    const shape = rect(box.x * size, box.y * size, box.w * size, box.h * size);
    return on.fits(shape) && (routed || boundary.fits(box)) && on.spaced(shape, AISLE * size);
  };
  // Siting has already accepted these with the canvas's own queries. On the coordinator a refusal
  // means the piece would leave a portal without a cord, and it is passed over; otherwise it is a defect.
  const commitError = (label: string) => `Plant placement ${label} failed its canvas commit.`;
  const commit = (on: SitingCanvas, label: string, assembly: CanvasAssembly) => {
    if (on.commit(assembly)) return true;
    if (!routed) throw new Error(commitError(label));
    return false;
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
    const sites = slots.map(slot => ({ slot, order: draw(brief.seed, slot.x, slot.y, CHANNEL.shedOrder), hinted: hintedSheds.has(key(slot.x, slot.y)) }))
      .sort((a, b) => Number(b.hinted) - Number(a.hinted) || a.order - b.order || a.slot.y - b.slot.y || a.slot.x - b.slot.x);
    // The first site that fits and that the canvas accepts.
    for (const site of sites) {
      if (!clear(canvas, box(site.slot))) continue;
      const shed = box(site.slot), label = 'plant-shed-1';
      const seed = Math.floor(draw(brief.seed, shed.x, shed.y, CHANNEL.design) * 2 ** 31);
      const built = expectPlaced(WAREHOUSE.build({ w: shed.w, h: shed.h, alongX: shed.w >= shed.h, seed, appearance: PLANT_SHED_APPEARANCE }, size)), { design, allocation, realization, rejected } = built.details;
      if (!commit(canvas, label, { elements: placedElements(built, label, shed.x, shed.y, size) })) continue;
      for (let j = 0; j < down; j++) for (let i = 0; i < across; i++) shedSlots.add(key(site.slot.x + i * PERIOD, site.slot.y + j * PERIOD));
      if (design.spaces.length > 1) designed++;
      observe?.({ label, origin: { x: shed.x * size, y: shed.y * size }, cellSize: size, design, allocation, realization, ...rejected.length ? { rejected } : {} });
      sheds = 1;
      break;
    }
  }

  // A machine in each slot that rolls under `density`, if its footprint fits.
  const machines = new Map<string, Box>(), machineShapes = new Map<string, Shape[]>();
  const passedSlots = new Set<string>();
  const hintedMachines = new Map<string, ReturnType<typeof boxesAgainstHints>>();
  const machineStage = phase(), sitedMachines: { key: string; box: Box; shapes: Shape[] }[] = [];
  for (const slot of slots) {
    if (shedSlots.has(key(slot.x, slot.y)) || draw(brief.seed, slot.x, slot.y, CHANNEL.machine) >= density) continue;
    passedSlots.add(key(slot.x, slot.y));
    const side = (channel: number) => MACHINE_MIN + Math.floor(draw(brief.seed, slot.x, slot.y, channel) * (MACHINE_MAX - MACHINE_MIN + 1));
    const w = side(CHANNEL.width), h = side(CHANNEL.height);
    const hintKey = `${w},${h}`;
    if (!hintedMachines.has(hintKey)) hintedMachines.set(hintKey, boxesAgainstHints(brief, w, h));
    const hint = hintedMachines.get(hintKey)!.find(candidate => candidate.x >= slot.x && candidate.y >= slot.y
      && candidate.x + w <= slot.x + BAND && candidate.y + h <= slot.y + BAND);
    const box = { x: hint?.x ?? slot.x + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.jitterX) * (BAND - w + 1)),
      y: hint?.y ?? slot.y + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.jitterY) * (BAND - h + 1)), w, h };
    if (!clear(machineStage.canvas, box)) continue;
    const chamfered = draw(brief.seed, slot.x, slot.y, CHANNEL.chamfer) < CHAMFERED;
    const machRng = rng(brief.seed, `${brief.id}:machine-appearance:${slot.x}:${slot.y}`);
    const machKind = chamfered ? 'cooling-tower' : machRng.next() < 0.5 ? 'substation' : 'machinery';
    const appearance: ObstacleAppearance = machKind === 'cooling-tower'
      ? { material: 'coolConcrete', focalRim: { side: 'N', color: 'sodiumAmber' } }
      : machKind === 'substation'
        ? { material: 'oxidizedMetal', focalRim: { side: 'E', color: 'electricTurquoise' } }
        : { material: 'oxidizedMetal', focalRim: { side: 'S', color: 'hotOrange' } };
    const built = expectPlaced(PLANT_MACHINE.build({ w, h, chamfered, appearance }, size)), label = `plant-machine-${sitedMachines.length + 1}`;
    const placed = placedElements(built, label, box.x, box.y, size);
    if (!commit(machineStage.canvas, label, { elements: placed })) continue;
    sitedMachines.push({ key: key(slot.x, slot.y), box, shapes: placed.flatMap(element => elementShapes(element)) });
  }
  const keptMachines = machineStage.flush();
  sitedMachines.forEach(({ key, box, shapes }, i) => {
    if (keptMachines && !keptMachines[i]) return;
    machines.set(key, box);
    machineShapes.set(key, shapes);
  });

  // Pipe runs between neighbouring machines, across then down, each with one door-wide gap.
  const pipeStage = phase();
  let sitedPipes = 0;
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
      const [element] = placedElements(built, `plant-pipe-${sitedPipes + 1}`, seated.x, seated.y, size);
      // Each stub less both machines, so it ends on their surfaces, as convex pieces local to the element.
      const ends = [...machineShapes.get(key(slot.x, slot.y))!, ...machineShapes.get(bKey)!];
      const pieces = element!.template.parts.flatMap(part => part.part === 'obstacle'
        ? construct([transform(part.shape, element!.x, element!.y)]).subtract(ends).pieces() : []);
      if (!pieces.length || pieces.some(piece => !pipeStage.canvas.fits(piece))) continue;
      const parts = pieces.map(piece => ({ part: 'obstacle' as const, kind: 'pipe' as const, shape: transform(piece, -element!.x, -element!.y) }));
      // It addresses each stub's cells, flush with its machines' boxes; the gap is left as the aisle it is.
      const areas = [[0, gap], [gap + AISLE, length]].filter(([s, e]) => e > s).map(([s, e]) => across
        ? rect((run.x + s) * size, run.y * size, (e - s) * size, size) : rect(run.x * size, (run.y + s) * size, size, (e - s) * size));
      if (commit(pipeStage.canvas, element!.label, { elements: [{ ...element!, template: { ...element!.template, parts } }], areas, extents: areas })) sitedPipes++;
    }
  }
  const keptPipes = pipeStage.flush(), pipes = keptPipes ? keptPipes.filter(Boolean).length : sitedPipes;

  // Address only remnants in slots whose original machine roll passed. This keeps the
  // continuous lattice aisles, skipped density slots and shed slots open. Pipe commits use
  // their stub areas as extents, so a crate can stand by the gap without crowding a stub.
  const crateStage = phase();
  const sitedCrates = placeInfillCrates({ brief, canvas: crateStage.canvas, chance: density, channels: CHANNEL,
    label: 'plant-infill-crate',
    site: cell => {
      const slotX = slots[0]!.x + Math.floor((cell.x - slots[0]!.x) / PERIOD) * PERIOD;
      const slotY = slots[0]!.y + Math.floor((cell.y - slots[0]!.y) / PERIOD) * PERIOD;
      return cell.x < slotX + BAND && cell.y < slotY + BAND && passedSlots.has(key(slotX, slotY))
        && accessMask.contains(rect((cell.x - AISLE) * size, (cell.y - AISLE) * size,
          (1 + 2 * AISLE) * size, (1 + 2 * AISLE) * size))
        && clear(crateStage.canvas, { x: cell.x, y: cell.y, w: 1, h: 1 });
    },
    ...routed ? {} : { commitError },
  });
  const keptCrates = crateStage.flush(), infillCrates = keptCrates ? keptCrates.filter(Boolean).length : sitedCrates;

  const elements = [...canvas.elements];
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { machines: machines.size, pipes, sheds, designed, infillCrates });
}
