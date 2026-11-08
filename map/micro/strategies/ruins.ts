import { compareCells } from '../../kernel/cell.ts';
import { polygon, rect } from '../../../shared/shape.ts';
import { FALLEN_SLAB } from '../placeables/fallen-slab.ts';
import { RUIN_ROOM_SPAN } from '../placeables/ruin-room-span.ts';
import { expectPlaced } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, fraction, liveCord, portalApproaches } from './scatter.ts';
import { draw, rng } from '../random.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { commitHintWalls, wallHints } from '../hint-walls.ts';
import { mergeAssemblies, type CanvasAssembly } from '../canvas.ts';
import { disjoint } from '../../../shared/shape-construction.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuildingAppearance, ObstacleAppearance } from '../../../shared/types.ts';
import { createTieredBuildingAppearance, type TieredAppearanceOptions } from '../building/decay.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';
import { builtRegion } from '../result.ts';
import { infillCrates as placeInfillCrates } from './infill.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';

/**
 * Authored minimal appearance descriptors for ruined masonry rooms (`ruins`) and collapsed slabs (11.1 §5.5, 54).
 * Ruin wall obstacles use high-value `dirtyCream` and `dustyStucco` masonry so Tier 2 ruin blockers
 * stay clearly separated (`>= 1.50` contrast) from dark asphalt, street, and floor surfaces across all palettes.
 */
export const RUIN_WALL_INTACT: ObstacleAppearance = Object.freeze({
  material: 'dirtyCream',
  focalRim: { side: 'N' as const, color: 'weatheredCoral' },
});

export const RUIN_WALL_WEATHERED: ObstacleAppearance = Object.freeze({
  material: 'dustyStucco',
  weathered: true,
  focalRim: { side: 'N' as const, color: 'sodiumAmber' },
});

export const RUIN_WALL_DAMAGED: ObstacleAppearance = Object.freeze({
  material: 'dirtyCream',
  weathered: true,
  focalRim: { side: 'S' as const, color: 'oldSignRed' },
});

export const FALLEN_SLAB_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'dustyStucco',
  weathered: true,
});

export const RUINS_BUILDING_INTACT: BuildingAppearance = Object.freeze({
  floorMaterial: 'warmMasonry',
  wallMaterial: 'dirtyCream',
  roofPaint: 'dustyStucco',
  roofRim: 'weatheredCoral',
  interiorTrim: 'weatheredCoral',
});

export const RUINS_BUILDING_WEATHERED: BuildingAppearance = Object.freeze({
  floorMaterial: 'warmMasonry',
  wallMaterial: 'dustyStucco',
  roofPaint: 'dirtyCream',
  roofRim: 'sodiumAmber',
  interiorTrim: 'oldSignRed',
  neglect: {
    fadedPanel: { dx: 18, dy: 24, w: 42, h: 20 },
    roofDrainStain: { dx: 54, dy: 20, w: 28, h: 18 },
  },
});

export const RUINS_BUILDING_DAMAGED: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'dirtyCream',
  roofPaint: 'coolConcrete',
  roofRim: 'oldSignRed',
  interiorTrim: 'oldSignRed',
  neglect: {
    fadedPanel: { dx: 16, dy: 22, w: 38, h: 18 },
    roofDrainStain: { dx: 50, dy: 18, w: 26, h: 18 },
    floorStain: { dx: 40, dy: 34, w: 32, h: 22 },
    scorchMark: { dx: 32, dy: 38, w: 44, h: 28 },
  },
});

export const RUINS_BUILDING_PRESETS: readonly [BuildingAppearance, BuildingAppearance, BuildingAppearance] = Object.freeze([
  RUINS_BUILDING_INTACT,
  RUINS_BUILDING_WEATHERED,
  RUINS_BUILDING_DAMAGED,
]);

export function selectRuinWallAppearance(roll: number): ObstacleAppearance {
  return roll < 0.35 ? RUIN_WALL_INTACT : roll < 0.75 ? RUIN_WALL_WEATHERED : RUIN_WALL_DAMAGED;
}

export function createRuinAppearance(options: TieredAppearanceOptions = {}): BuildingAppearance {
  return createTieredBuildingAppearance(options, {
    presets: RUINS_BUILDING_PRESETS,
    thresholds: [0.25, 0.65],
    tierChannel: 'ruin-tier',
  });
}

const DEFAULT_DENSITY = 0.7;
const DEFAULT_DECAY = 0.35;
/** Cells between room slots. A room is 3 or 4 cells, so at least a doorway-wide alley (52) parts two rooms. */
const PERIOD = 6;
/** A wall is a quarter cell thick, as `hut`'s are. */
const WALL = 0.25;
/** The catalogue's proposed shape need (54). */
const MIN_CELLS = 24;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { slot: 1, width: 2, height: 3, door: 4, doorAt: 5, loot: 6, phase: 7, span: 10, debris: 20, angle: 30, size: 40,
  infill: 100, infillLength: 101, infillOffset: 102 };
/** The four sides of a room, in the order their channels are offset by. */
const SIDES = ['north', 'east', 'south', 'west'] as const;
type Side = typeof SIDES[number];

/**
 * The `ruins` region type (54): roofless rooms with broken walls, and their fallen spans as
 * rotated debris. It has no decomposer.
 *
 * Room slots lie on a lattice `PERIOD` cells apart, at a seeded phase. A slot is taken with
 * chance `density` by a room of 3 or 4 cells a side, wholly on owned cells. Its walls are
 * laid a cell at a time along the inside of its box. One side, where the cells beyond are
 * owned, has a doorway two cells wide, so nothing inside is sealed off. Every other span
 * falls with chance `decay`: half of those lie as a rotated slab of debris on their cell,
 * and the rest are gone.
 *
 * Portal approaches stay clear, and nothing else is reserved between portals: pieces commit
 * through a live cord (20.10), which keeps a hunter cord to every portal stand. The rooms are
 * tried as one commit; if the cord refuses them, each room keeps the most of its spans that
 * leave a cord, and the rest are left out as broken wall (#787). Then plain walls stand along
 * every hinted run where no piece or approach is (`wallHints`), each passed over if the cord
 * refuses it. So the region keeps the portal promise whenever its shape does. A region smaller than
 * `MIN_CELLS`, or with no owned 3 × 3 box for a room, goes to `open` (17 M24).
 *
 * Residual crates keep two cells from every eligible room slot, including density-skipped
 * slots, plus existing extents. They are sited on a draft and committed as far as the cord
 * allows. Each needs a fully owned two-cell
 * bypass ring; room interiors and door approaches remain clear.
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear
 * of every piece. Ruins site no core elements; any the brief lists are left for the report.
 */
export function buildRuins(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'Ruins', 'density', DEFAULT_DENSITY);
  const decay = fraction(brief, 'Ruins', 'decay', DEFAULT_DECAY);
  const mask = createFillMask(brief), size = brief.cellSize;
  if (mask.cells.length < MIN_CELLS || !mask.rectangles(3, 3).length) return unfilledRegion(brief, CHANNEL.loot);

  const approaches = portalApproaches(brief, 'Ruins'), canvas = liveCord(brief, 'Ruins');
  const phase = { x: Math.floor(draw(brief.seed, 0, 0, CHANNEL.phase) * PERIOD), y: Math.floor(draw(brief.seed, 1, 0, CHANNEL.phase) * PERIOD) };
  const onLattice = (value: number, offset: number) => ((value - offset) % PERIOD + PERIOD) % PERIOD === 0;
  const owns = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (!mask.has(i, j)) return false;
    return true;
  };

  // A room's laid spans and their shapes, committed together once all rooms are sited: spans meet at its corners.
  let room: RegionElement[] = [], roomShapes: Shape[] = [];
  const sited: { elements: RegionElement[]; shapes: Shape[] }[] = [];
  const reserved: { x: number; y: number; w: number; h: number }[] = [];
  let rooms = 0;
  const lay = (label: string, shape: Shape, appearance: ObstacleAppearance) => {
    if (!canvas.fits(shape)) return false;
    room.push({ label, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h,
      parts: [{ part: 'obstacle', shape, kind: 'ruin-wall', appearance }] } });
    roomShapes.push(shape);
    return true;
  };

  for (const slot of [...mask.cells].sort(compareCells)) {
    if (!onLattice(slot.x, phase.x) || !onLattice(slot.y, phase.y)) continue;
    const w = 3 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.width) * 2);
    const h = 3 + Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.height) * 2);
    if (!owns(slot.x, slot.y, w, h)) continue;
    // The doorway's side must open onto owned cells, two deep, or the room could be sealed.
    const beyond: Record<Side, boolean> = {
      north: owns(slot.x, slot.y - 2, w, 2), east: owns(slot.x + w, slot.y, 2, h),
      south: owns(slot.x, slot.y + h, w, 2), west: owns(slot.x - 2, slot.y, 2, h),
    };
    const open = SIDES.filter(side => beyond[side]);
    if (!open.length) continue;
    // Reserve every eligible slot, including density-skipped rooms.
    reserved.push({ x: slot.x, y: slot.y, w, h });
    if (draw(brief.seed, slot.x, slot.y, CHANNEL.slot) >= density) continue;
    const door = open[Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.door) * open.length)]!;
    rooms++;
    room = []; roomShapes = [];
    const doorLength = door === 'north' || door === 'south' ? w : h;
    const doorAt = Math.floor(draw(brief.seed, slot.x, slot.y, CHANNEL.doorAt) * (doorLength - 1));
    // The doorway's two spans, and the end span of a side it meets at a corner, so the gap stays two cells wide.
    const gaps = new Set([`${door}:${doorAt}`, `${door}:${doorAt + 1}`]);
    const [before, after] = door === 'north' || door === 'south' ? ['west', 'east'] : ['north', 'south'];
    const end = door === 'north' || door === 'west' ? 0 : (door === 'south' ? h : w) - 1;
    if (doorAt === 0) gaps.add(`${before}:${end}`);
    if (doorAt + 2 === doorLength) gaps.add(`${after}:${end}`);
    for (const [s, side] of SIDES.entries()) {
      const across = side === 'north' || side === 'south', length = across ? w : h;
      for (let i = 0; i < length; i++) {
        if (gaps.has(`${side}:${i}`)) continue;
        const cx = across ? slot.x + i : side === 'west' ? slot.x : slot.x + w - 1;
        const cy = across ? (side === 'north' ? slot.y : slot.y + h - 1) : slot.y + i;
        const label = `ruins-${side}-${cx}-${cy}`;
        if (draw(brief.seed, cx, cy, CHANNEL.span + s) >= decay) {
          const wallApp = selectRuinWallAppearance(rng(brief.seed, `${brief.id}:ruin-wall:${cx}:${cy}:${side}`).next());
          const span = expectPlaced(RUIN_ROOM_SPAN.build({ side, appearance: wallApp }, size));
          const local = (span.elements[0]!.template.parts[0] as { shape: Shape }).shape;
          if (local.kind !== 'rect') throw new Error('A ruin room span must be a rectangle.');
          // Keep the old arithmetic order in the absolute-shape record, including fractional cell sizes.
          const shape = rect(side === 'east' ? (cx + 1) * size - local.w : cx * size,
            side === 'south' ? (cy + 1) * size - local.h : cy * size, local.w, local.h);
          lay(`${label}-wall`, shape, wallApp);
        } else if (draw(brief.seed, cx, cy, CHANNEL.debris + s) < .5)
          lay(`${label}-debris`, slab(cx, cy, size, draw(brief.seed, cx, cy, CHANNEL.angle + s), draw(brief.seed, cx, cy, CHANNEL.size + s)), FALLEN_SLAB_APPEARANCE);
      }
    }
    if (room.length) sited.push({ elements: room, shapes: roomShapes });
  }
  // These legacy world-absolute records' template boxes are not their intent; their shapes are.
  // The room's box is not either, as the cord may run through a fallen span.
  const assembly = (elements: readonly RegionElement[], shapes: readonly Shape[]): CanvasAssembly =>
    ({ elements, areas: disjoint(shapes), extents: shapes });
  const all = mergeAssemblies(sited.map(r => assembly(r.elements, r.shapes)));
  if (sited.length && !canvas.commit(all)) for (const r of sited)
    canvas.commitWhile(r.elements.length, kept => kept.some(Boolean)
      ? assembly(r.elements.filter((_, i) => kept[i]), r.shapes.filter((_, i) => kept[i])) : null);
  const laid = canvas.elements, pieces = laid.flatMap(e => elementShapes(e));
  const walls = laid.filter(e => e.label.endsWith('-wall')).length, debris = laid.filter(e => e.label.endsWith('-debris')).length;

  const hinted = commitHintWalls(canvas, wallHints(brief, { kind: 'ruin-wall', thickness: WALL, avoid: [...approaches, ...pieces], appearance: RUIN_WALL_WEATHERED }), { passOver: true });
  const aisle = CELL_SCALE.doorway, access = createAccessMask(brief);
  const crates = canvas.stage();
  placeInfillCrates({ brief, canvas: crates.canvas, chance: density * 0.5, channels: CHANNEL,
    label: 'ruins-infill-crate',
    site: cell => {
      const shape = rect(cell.x * size, cell.y * size, size, size);
      return reserved.every(box => Math.max(box.x - cell.x - 1, cell.x - box.x - box.w,
        box.y - cell.y - 1, cell.y - box.y - box.h) >= aisle)
        && access.contains(rect((cell.x - aisle) * size, (cell.y - aisle) * size,
          (1 + 2 * aisle) * size, (1 + 2 * aisle) * size))
        && crates.canvas.fits(shape) && crates.canvas.spaced(shape, aisle * size);
    },
    commitError: label => `Ruins placement ${label} failed its canvas commit.`,
  });
  const infillCrates = crates.flush().filter(Boolean).length;
  const elements = [...canvas.elements];
  const lootPieces = infillCrates ? elements.flatMap(element => elementShapes(element, true)) : [...pieces, ...hinted.shapes];
  const loot = cellLoot(brief, createRegionMask(brief), lootPieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { rooms, walls, debris, hintWalls: hinted.shapes.length, infillCrates });
}

/** Adapt a locally built slab to the legacy world-absolute element record. */
function slab(cx: number, cy: number, size: number, turn: number, length: number): Shape {
  const built = expectPlaced(FALLEN_SLAB.build({ turn, length }, size));
  const local = (built.elements[0]!.template.parts[0] as { shape: Shape }).shape;
  if (local.kind !== 'polygon') throw new Error('A fallen slab must be a polygon.');
  return polygon((cx + .5) * size, (cy + .5) * size, local.points);
}
