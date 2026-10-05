import { polygon, rect } from '../../../shared/shape.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { buildOpen } from './open.ts';
import { largestRectangle } from './hall.ts';
import { warehouse } from './depot.ts';
import { cellLoot, draw, fraction } from './scatter.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

/** The catalogue's proposed shape need (54), as `depot`'s: a contained square at least this many cells a side. */
const MIN_SIDE = 10;
/**
 * Clear cells around every piece's box, from every other piece and from any cell the region
 * doesn't own, and the width of every gap in a pipe run: a doorway (52), so a hunter fits each.
 */
const AISLE = CELL_SCALE.doorway;
/** Cells from one slot to the next. A slot's pieces stay in its first `BAND` cells, so the rest is aisle. */
const PERIOD = 8, BAND = PERIOD - AISLE;
const DEFAULT_DENSITY = 0.6, DEFAULT_SHED = 0.5;
/** A machine's sides in cells, and how far its body stands inside them. */
const MACHINE_MIN = 2, MACHINE_MAX = 4, INSET = 0.05;
/** How much of a machine's corner a chamfer cuts, in cells, and the chance a machine has one. */
const CHAMFER = 0.5, CHAMFERED = 0.5;
/** The chance two neighbouring machines are joined, and a pipe's thickness in cells, centred in its row. */
const JOINED = 0.7, PIPE = 0.3;
/** How far a pipe reaches into the machines it joins, in cells, so it meets a chamfered face. */
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
 * Every machine's and shed's box keeps `AISLE` clear cells from every other's and from any cell
 * the region doesn't own, and so does every pipe run's but for the machines it joins. A run
 * stays in its machines' band and crosses only the aisle between them, so runs never meet. The
 * machines and runs can wall off ground between them, but every run has its gap, so no ground
 * is shut off, and like `depot` the region keeps the portal promise exactly when its shape does.
 * A region with no contained `MIN_SIDE` square goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every piece, indoors or out. A plant sites no core elements; any the brief lists are left for
 * the report. `observe`, when given, sees the shed's design as `depot` reports its warehouses.
 */
export function buildPlant(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const density = fraction(brief, 'Plant', 'density', DEFAULT_DENSITY);
  const shedChance = fraction(brief, 'Plant', 'shed', DEFAULT_SHED);
  const mask = createRegionMask(brief), size = brief.cellSize;
  if (!largestRectangle(mask, MIN_SIDE)) return buildOpen(brief);

  // Every cell of a box and its ring of AISLE cells is owned.
  const clear = ({ x, y, w, h }: Box) => {
    for (let j = Math.floor(y) - AISLE; j < Math.ceil(y + h) + AISLE; j++)
      for (let i = Math.floor(x) - AISLE; i < Math.ceil(x + w) + AISLE; i++) if (!mask.has(i, j)) return false;
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
  const place = (label: string, box: Box, parts: RegionElement['template']['parts'], encloses = false) =>
    elements.push({ label, x: box.x * size, y: box.y * size, template: { w: box.w * size, h: box.h * size, ...encloses ? { encloses } : {}, parts } });

  // The shed, at the first block of slots in a seeded order whose box fits.
  const shedSlots = new Set<string>();
  let sheds = 0, designed = 0;
  if (draw(brief.seed, 0, 0, CHANNEL.shed) < shedChance) {
    const [across, down] = SHEDS[Math.floor(draw(brief.seed, 0, 0, CHANNEL.shedSize) * SHEDS.length)]!;
    const box = (slot: { x: number; y: number }): Box => ({ x: slot.x, y: slot.y, w: across * PERIOD - AISLE, h: down * PERIOD - AISLE });
    const site = slots.map(slot => ({ slot, order: draw(brief.seed, slot.x, slot.y, CHANNEL.shedOrder) }))
      .sort((a, b) => a.order - b.order || a.slot.y - b.slot.y || a.slot.x - b.slot.x).find(({ slot }) => clear(box(slot)));
    if (site) {
      const shed = box(site.slot), label = 'plant-shed-1';
      for (let j = 0; j < down; j++) for (let i = 0; i < across; i++) shedSlots.add(key(site.slot.x + i * PERIOD, site.slot.y + j * PERIOD));
      const seed = Math.floor(draw(brief.seed, shed.x, shed.y, CHANNEL.design) * 2 ** 31);
      const built = warehouse(size, shed.w, shed.h, shed.w >= shed.h, seed);
      if (built.design.spaces.length > 1) designed++;
      observe?.({ label, origin: { x: shed.x * size, y: shed.y * size }, cellSize: size, design: built.design, allocation: built.allocation,
        realization: built.realization, ...built.rejected.length ? { rejected: built.rejected } : {} });
      elements.push({ label, x: shed.x * size, y: shed.y * size, template: built.template });
      sheds = 1;
    }
  }

  // A machine in each slot that rolls under `density`, if its box keeps its ring.
  const machines = new Map<string, Box>();
  for (const slot of slots) {
    if (shedSlots.has(key(slot.x, slot.y)) || draw(brief.seed, slot.x, slot.y, CHANNEL.machine) >= density) continue;
    const side = (channel: number) => MACHINE_MIN + Math.floor(draw(brief.seed, slot.x, slot.y, channel) * (MACHINE_MAX - MACHINE_MIN + 1));
    const w = side(CHANNEL.width), h = side(CHANNEL.height);
    const box = { x: slot.x + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.jitterX) * (BAND - w + 1)),
      y: slot.y + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.jitterY) * (BAND - h + 1)), w, h };
    if (!clear(box)) continue;
    machines.set(key(slot.x, slot.y), box);
    const chamfered = draw(brief.seed, slot.x, slot.y, CHANNEL.chamfer) < CHAMFERED;
    place(`plant-machine-${machines.size}`, box, [{ part: 'obstacle', shape: machine(size, w, h, chamfered), kind: 'container' }]);
  }

  // Pipe runs between neighbouring machines, across then down, each with one door-wide gap.
  let pipes = 0;
  for (const slot of slots) {
    const a = machines.get(key(slot.x, slot.y));
    if (!a) continue;
    for (const across of [true, false]) {
      const b = machines.get(across ? key(slot.x + PERIOD, slot.y) : key(slot.x, slot.y + PERIOD));
      if (!b) continue;
      // Along u from a's far face to b's near face, in a row v that both span.
      const [u0, u1] = across ? [a.x + a.w, b.x] : [a.y + a.h, b.y];
      const [v0, v1] = across ? [Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h)] : [Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w)];
      const length = u1 - u0, channel = RUN_CHANNEL[across ? 'across' : 'down'];
      const roll = (name: keyof typeof channel) => draw(brief.seed, slot.x, slot.y, channel[name]);
      if (v1 <= v0 || length < AISLE + 1 || roll('joined') >= JOINED) continue;
      const v = v0 + Math.floor(roll('row') * (v1 - v0)), gap = Math.floor(roll('gap') * (length - AISLE + 1));
      const run: Box = across ? { x: u0, y: v, w: length, h: 1 } : { x: v, y: u0, w: 1, h: length };
      if (!clear(run)) continue;
      // Local to the run's box, which reaches SEAT into each machine.
      const stubs: [number, number][] = [[-SEAT, gap], [gap + AISLE, length + SEAT]];
      const parts = stubs.filter(([s, e]) => e - s > SEAT).map(([s, e]) => ({ part: 'obstacle' as const, kind: 'pipe' as const,
        shape: across ? rect((s + SEAT) * size, (0.5 - PIPE / 2) * size, (e - s) * size, PIPE * size)
          : rect((0.5 - PIPE / 2) * size, (s + SEAT) * size, PIPE * size, (e - s) * size) }));
      if (!parts.length) continue;
      const seated = across ? { ...run, x: run.x - SEAT, w: run.w + 2 * SEAT } : { ...run, y: run.y - SEAT, h: run.h + 2 * SEAT };
      place(`plant-pipe-${++pipes}`, seated, parts);
    }
  }

  const parts = elements.flatMap(element => element.template.parts);
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, mask, pieces, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: sheds, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0,
      machines: machines.size, pipes, sheds, designed } };
}

/** A machine's body in a `w` × `h` cell box: a block a little inside it, its corners cut when `chamfered`. */
function machine(size: number, w: number, h: number, chamfered: boolean): Shape {
  const x0 = INSET * size, y0 = INSET * size, x1 = (w - INSET) * size, y1 = (h - INSET) * size;
  if (!chamfered) return rect(x0, y0, x1 - x0, y1 - y0);
  const c = CHAMFER * size;
  return polygon(0, 0, [{ x: x0 + c, y: y0 }, { x: x1 - c, y: y0 }, { x: x1, y: y0 + c }, { x: x1, y: y1 - c },
    { x: x1 - c, y: y1 }, { x: x0 + c, y: y1 }, { x: x0, y: y1 - c }, { x: x0, y: y0 + c }]);
}
