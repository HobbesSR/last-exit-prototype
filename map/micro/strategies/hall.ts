import { rect, bounds } from '../../../shared/shape.ts';
import { HALL_PILLAR, HALL_PILLAR_INSET as INSET } from '../placeables/hall-pillar.ts';
import { expectPlaced } from '../placeables/placeable.ts';
import { unfilledRegion, cellLoot, protectedRoutes } from './scatter.ts';
import { draw } from '../random.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { wallHints } from '../hint-walls.ts';
import { construct } from '../../../shared/shape-construction.ts';
import { createBuilderCanvas } from '../canvas.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { BuiltRegion, RegionBrief, RegionElement, RegionMask } from '../types.ts';
import { builtRegion } from '../result.ts';
import { infillCrates as placeInfillCrates } from './infill.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';

/** The catalogue's proposed shape need (54): a contained rectangle at least this many cells a side. */
const MIN_SIDE = 6;
/** A pillar stands on a 2 × 2 block of cells, as mapgen's `pillar-hall` blocks did. */
const BLOCK = 2;
/**
 * Cells from one pillar's block to the next. The least leaves an aisle of 2½ cells between
 * pillars, a doorway (52) with room for the sampled route search (20).
 */
const MIN_SPACING = 4;
const DEFAULT_SPACING = 5;
/** Leaves a sampled hunter lane even beside quarter-cell hinted perimeter walls. */
const WING_MARGIN = 2.5;

/** Per-cell draw channels, so no choice shifts another. */
const CHANNEL = { axis: 1, loot: 2, infill: 20, infillLength: 21, infillOffset: 22 };

type Box = { x: number; y: number; w: number; h: number };

/**
 * The `hall` region type (54): a staggered lattice of pillars that breaks sightlines without
 * blocking a walk. It has no decomposer.
 *
 * It takes the region's largest contained rectangle at least `MIN_SIDE` cells a side.
 * Pillar blocks lie `spacing` cells apart on the rectangle, centred in it. Each row is
 * offset from the last by about half a period along
 * one axis, drawn from the seed, so a sightline down that axis meets a pillar within a few
 * rows. The other axis keeps clean lanes, the walk the design leaves open. Only one axis is
 * staggered: staggering both pinches pillar corners together.
 *
 * Portal approaches and one hunter route between portals are protected in the empty shape
 * first, and a pillar that would touch them is left out, as `rubble` and `ruins` do. Then
 * plain walls stand along every hinted run where nothing of the hall's or the routes' is
 * (`wallHints`). So the region keeps the portal promise whenever its shape does. With `roofed`, the rectangle has a
 * roof, which hides what's under it as a building's does. A region with no such rectangle
 * goes to `open` (17 M24).
 *
 * Side-connected residual rectangles become secondary bays with a 2.5-cell perimeter walk.
 * Their lattice is centred separately, keeping the primary unchanged. Each roofed bay is an
 * enclosing element, with no internal wall across its joins. Remaining pockets may receive
 * crates outside a two-cell buffer around every selected bay. Each crate requires a fully owned two-cell bypass ring
 * and two-cell separation from other pieces. Market uses its own dedicated builder.
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear
 * of all final obstacles, including pillars, hint walls, crates and gates. A hall sites no
 * core elements; any the brief lists are left for the report.
 */
export function buildHall(brief: RegionBrief): BuiltRegion {
  const spacing = brief.parameters?.spacing ?? DEFAULT_SPACING;
  if (typeof spacing !== 'number' || !Number.isInteger(spacing) || spacing < MIN_SPACING)
    throw new RangeError(`Hall spacing must be a whole number of cells, at least ${MIN_SPACING}.`);
  const roofed = brief.parameters?.roofed ?? false;
  if (typeof roofed !== 'boolean') throw new TypeError('Hall roofed must be true or false.');

  const mask = createFillMask(brief), size = brief.cellSize;
  const box = largestRectangle(mask, MIN_SIDE);
  if (!box) return unfilledRegion(brief, CHANNEL.loot);

  const protectedShapes = protectedRoutes(brief, 'Hall');
  const canvas = createBuilderCanvas(brief, protectedShapes);
  const staggerRows = draw(brief.seed, 0, 0, CHANNEL.axis) < 0.5;
  const stride = staggerStride(spacing);
  const pillar = expectPlaced(HALL_PILLAR.build({}, size));
  const local = (pillar.elements[0]!.template.parts[0] as { shape: Shape }).shape;
  if (local.kind !== 'rect') throw new Error('A hall pillar must be a rectangle.');
  const span = local.w;

  const boxes = hallRectangles(mask, box), pillars: Shape[] = [];
  const hall: RegionElement[] = [];
  for (const [index, wing] of boxes.entries()) {
    // Secondary bays retain a 2.5-cell perimeter walk, including the open join to
    // earlier bays. The primary lattice keeps its original phase and geometry.
    const inset = index ? WING_MARGIN : 0;
    const inner = { x: wing.x + inset, y: wing.y + inset, w: wing.w - 2 * inset, h: wing.h - 2 * inset };
    const [us, ul, vs, vl] = staggerRows ? [inner.x, inner.w, inner.y, inner.h] : [inner.y, inner.h, inner.x, inner.w];
    const ou = us + Math.floor((ul - BLOCK) % spacing / 2), ov = vs + Math.floor((vl - BLOCK) % spacing / 2);
    const parts: ElementTemplate['parts'] = [];
    for (let v = ov, line = 0; inner.w >= BLOCK && inner.h >= BLOCK && v + BLOCK <= vs + vl; v += spacing, line++) {
      // Each line starts a period early, so its first block can stand at the near end.
      for (let u = ou + (line * stride) % spacing - spacing; u + BLOCK <= us + ul; u += spacing) {
        if (u < us) continue;
        const [bx, by] = staggerRows ? [u, v] : [v, u];
        const shape = rect((bx + INSET) * size, (by + INSET) * size, span, span);
        if (!canvas.fits(shape)) continue;
        if (index && pillars.some(p => {
          const b = bounds(p);
          return Math.max(b.x - shape.x - span, shape.x - b.x - b.w,
            b.y - shape.y - span, shape.y - b.y - b.h) < CELL_SCALE.doorway * size;
        })) continue;
        pillars.push(shape);
        parts.push({ part: 'obstacle', shape: rect((bx - wing.x + INSET) * size, (by - wing.y + INSET) * size, span, span), kind: 'building' });
      }
    }
    if (parts.length || roofed) hall.push({ label: index ? `hall-wing-${index}` : 'hall', x: wing.x * size, y: wing.y * size,
      template: { w: wing.w * size, h: wing.h * size, ...(roofed ? { encloses: true } : {}), parts } });
  }

  const walls = wallHints(brief, { kind: 'building', avoid: [...protectedShapes, ...pillars] });
  // The hall bays and hint walls commit as one assembly. Their intent is their rectangles and the
  // walls, less the protected routes it keeps clear (29's construction). Siting has already
  // accepted the hall, so a refusal is a broken placement invariant.
  const rectangles = hall.map(e => rect(e.x, e.y, e.template.w, e.template.h));
  const areas = construct([...rectangles, ...walls.shapes]).subtract(protectedShapes).pieces();
  if ((hall.length || walls.elements.length) && !canvas.commit({ elements: [...hall, ...walls.elements],
    areas, extents: [...rectangles, ...walls.shapes] }))
    throw new Error('Hall placement failed its canvas commit.');
  // Every selected bay remains reserved even when no pillar or roof was placed.
  // A full owned bypass ring preserves access to side lobes with no protected route.
  const aisle = CELL_SCALE.doorway, access = createAccessMask(brief);
  const infillCrates = brief.type === 'hall' ? placeInfillCrates({ brief, canvas, chance: 0.5, channels: CHANNEL,
    label: 'hall-infill-crate',
    site: cell => {
      const shape = rect(cell.x * size, cell.y * size, size, size);
      return boxes.every(b => Math.max(b.x - cell.x - 1, cell.x - b.x - b.w,
        b.y - cell.y - 1, cell.y - b.y - b.h) >= aisle) && access.contains(rect((cell.x - aisle) * size, (cell.y - aisle) * size,
        (1 + 2 * aisle) * size, (1 + 2 * aisle) * size)) && canvas.fits(shape) && canvas.spaced(shape, aisle * size);
    },
    commitError: label => `Hall placement ${label} failed its canvas commit.`,
  }) : undefined;
  const elements = [...canvas.elements];
  const lootPieces = infillCrates !== undefined ? elements.flatMap(element => elementShapes(element, true)) : [...pillars, ...walls.shapes];
  const loot = cellLoot(brief, createRegionMask(brief), lootPieces, CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { pillars: pillars.length, hintWalls: walls.shapes.length,
    ...(hall.some(e => e.label !== 'hall') ? { wings: hall.filter(e => e.label !== 'hall').length } : {}),
    ...(infillCrates === undefined ? {} : { infillCrates }) });
}

/** Partition residual fill into bays; only side-connected bays join the hall.
 * Thin necks and detached annexes retain the existing residual-infill policy.
 * Reserving whole rectangles (even route-only ones) prevents reclaiming an
 * intentionally clear part of the primary lattice as a new bay.
 */
function hallRectangles(mask: RegionMask, primary: Box): Box[] {
  const inside = (c: { x: number; y: number }, b: Box) => c.x >= b.x && c.x < b.x + b.w && c.y >= b.y && c.y < b.y + b.h;
  let remaining = mask.cells.filter(c => !inside(c, primary));
  const pending: Box[] = [];
  while (remaining.length) {
    const next = largestRectangle(createRegionMask({ cells: remaining, cellSize: mask.cellSize }), MIN_SIDE);
    if (!next) break;
    pending.push(next);
    remaining = remaining.filter(c => !inside(c, next));
  }
  const connected = (a: Box, b: Box) =>
    ((a.x + a.w === b.x || b.x + b.w === a.x) && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= CELL_SCALE.doorway)
    || ((a.y + a.h === b.y || b.y + b.h === a.y) && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= CELL_SCALE.doorway);
  const boxes = [primary];
  for (;;) {
    const index = pending.findIndex(b => boxes.some(a => connected(a, b)));
    if (index < 0) return boxes;
    boxes.push(pending.splice(index, 1)[0]!);
  }
}

/**
 * How far each line of blocks is offset from the last, in cells: as near half a period as
 * whole cells allow, sharing no factor with the period. A stride that shares one visits only
 * some phases, so a lane between them stays open the whole way (spacing 6 with stride 4
 * visits 0, 4 and 2, never the odd cells). One that shares none visits every phase within a
 * period's worth of lines.
 */
export function staggerStride(spacing: number): number {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  // Odd periods try the lower of the two halves first, even ones the upper, as the stride always has.
  for (let d = 0; ; d++) {
    const tries = spacing % 2 ? [(spacing - 1) / 2 - d, (spacing + 1) / 2 + d] : [spacing / 2 + d, spacing / 2 - d];
    const stride = tries.find(t => t > 0 && t < spacing && gcd(t, spacing) === 1);
    if (stride) return stride;
  }
}

/**
 * The owned rectangle of largest area, in cells, with both sides at least `least`, or nothing.
 * Ties go to the first in row order, so the choice doesn't depend on the brief's cell order.
 */
export function largestRectangle(mask: Pick<RegionMask, 'cellSize' | 'bounds' | 'has'>, least: number): Box | undefined {
  const size = mask.cellSize;
  const x0 = Math.round(mask.bounds.x / size), y0 = Math.round(mask.bounds.y / size);
  const w = Math.round(mask.bounds.w / size), h = Math.round(mask.bounds.h / size);
  const heights = new Array<number>(w).fill(0);
  let best: Box | undefined;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) heights[x] = mask.has(x0 + x, y0 + y) ? heights[x]! + 1 : 0;
    // Every maximal rectangle ending on this row is the widest run at one bar's height.
    const stack: number[] = [];
    for (let x = 0; x <= w; x++) {
      const height = x < w ? heights[x]! : 0;
      while (stack.length && heights[stack[stack.length - 1]!]! >= height) {
        const top = heights[stack.pop()!]!, left = stack.length ? stack[stack.length - 1]! + 1 : 0, width = x - left;
        if (top >= least && width >= least && (!best || top * width > best.w * best.h))
          best = { x: x0 + left, y: y0 + y - top + 1, w: width, h: top };
      }
      stack.push(x);
    }
  }
  return best;
}
