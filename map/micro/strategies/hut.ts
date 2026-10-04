import { circle } from '../../../shared/shape.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { rng } from '../index.ts';
import { createRegionMask, elementShapes, shapesOverlap } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { portalStands } from '../portals.ts';
import { emitWallRun } from '../building/walls.ts';
import { buildOpen } from './open.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { BuiltRegion, LootSite, RegionBrief } from '../types.ts';

/** The building's box in cells (54, proposed). */
const BOX = 4;
/** The least extent a hut region has on each axis, in cells (54, proposed). Smaller goes to `open`. */
const REGION = 6;
/** Wall thickness, in cells. */
const WALL = 0.25;
/** A hunter fits a 2 × 2 block of cells, and moving it by one cell sweeps a 2 × 3 rectangle. */
const BODY = 2;

type Side = 'N' | 'E' | 'S' | 'W';
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/**
 * The `hut` region type (54): one small building in its yard, with no decomposer.
 *
 * The builder works in cells, where a hunter is a 2 × 2 block of yard cells. It tries the
 * region's contained 4 × 4 boxes in a seeded order and takes the first that:
 * - stays off every portal's approach, the two cells inward along it, where its hunter stands are
 * - leaves every two portals that the empty region joined still joined through the yard
 * - has a side whose doorstep, the 2 × 2 block outside the door, the yard joins to a portal.
 *
 * The house stands in the box with walls, that door, a window opposite and a roof. It has one
 * door, so no route runs through it, and its interior is reached through the door. A region
 * with no such box goes to `open`, the last resort (17 M24), as the fixture's 2 × 3 huts do.
 * So the region keeps the portal promise exactly when its shape does.
 *
 * Loot rolls each cell's chance and takes the cell's tier (52, "Tier zones"), where a loot
 * disc stands clear of the walls and the door. A hut sites no core elements; any the brief
 * lists are left for the report to name (51 stage 8).
 */
export function buildHut(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize, mask = createRegionMask(brief);
  const site = siteHut(brief, mask);
  if (!site) return buildOpen(brief);

  const element = { label: 'hut-building', x: site.x * size, y: site.y * size, template: house(size, site.door) };
  const shapes = elementShapes(element, true), radius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(c => [`${c.x},${c.y}`, zone] as const)));
  const lootRandom = rng(brief.seed, `${brief.id}:hut-loot`), loot: LootSite[] = [];
  for (const cell of mask.cells) {
    const zone = zones.get(`${cell.x},${cell.y}`)!, roll = lootRandom.next(), jx = lootRandom.next(), jy = lootRandom.next();
    if (roll >= zone.lootChance) continue;
    const x = (cell.x + 0.35 + jx * 0.3) * size, y = (cell.y + 0.35 + jy * 0.3) * size, disc = circle(x, y, radius);
    if (mask.contains(disc) && !shapes.some(shape => shapesOverlap(disc, shape))) loot.push({ x, y, tier: zone.tier });
  }

  const parts = element.template.parts;
  return { version: 'region-2', brief: structuredClone(brief), elements: [element], coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 1, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0 } };
}

/** The box's top-left cell and its door's side, or nothing when no box keeps the region's promise. */
function siteHut(brief: RegionBrief, mask: ReturnType<typeof createRegionMask>): { x: number; y: number; door: Side } | undefined {
  const xs = mask.cells.map(c => c.x), ys = mask.cells.map(c => c.y);
  if (Math.max(...xs) - Math.min(...xs) + 1 < REGION || Math.max(...ys) - Math.min(...ys) + 1 < REGION) return undefined;
  const key = (x: number, y: number) => `${x},${y}`;
  const fits = (x: number, y: number, inBox: (x: number, y: number) => boolean) => {
    for (let j = y; j < y + BODY; j++) for (let i = x; i < x + BODY; i++) if (!mask.has(i, j) || inBox(i, j)) return false;
    return true;
  };
  // Label the blocks a hunter can stand on, joined where it can step one cell across.
  const label = (inBox: (x: number, y: number) => boolean) => {
    const labels = new Map<string, number>();
    for (const start of mask.cells) {
      if (labels.has(key(start.x, start.y)) || !fits(start.x, start.y, inBox)) continue;
      const id = labels.size, queue = [start];
      labels.set(key(start.x, start.y), id);
      for (let head = 0; head < queue.length; head++) {
        const { x, y } = queue[head]!;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
          if (labels.has(key(nx, ny)) || !fits(nx, ny, inBox)) continue;
          labels.set(key(nx, ny), id); queue.push({ x: nx, y: ny });
        }
      }
    }
    return labels;
  };

  // Each portal's approach: the cells two deep inward along it, and the blocks a hunter stands on there.
  const approach = new Set<string>(), entrances: string[] = [];
  for (const { portal: { axis, x, y, length }, inward } of portalStands(brief, mask)) {
    const blocks: string[] = [];
    for (let i = 0; i < length; i++) for (let d = 0; d < BODY; d++) {
      const depth = inward.x + inward.y > 0 ? d : -1 - d;
      approach.add(axis === 'h' ? key(x + i, y + depth) : key(x + depth, y + i));
    }
    for (let i = 0; i + BODY <= length; i++) {
      const corner = inward.x + inward.y > 0 ? 0 : -BODY;
      blocks.push(axis === 'h' ? key(x + i, y + corner) : key(x + corner, y + i));
    }
    const entrance = blocks.find(block => { const [bx, by] = block.split(',').map(Number) as [number, number]; return fits(bx, by, () => false); });
    if (entrance) entrances.push(entrance);
  }

  const empty = label(() => false), random = rng(brief.seed, `${brief.id}:hut-site`);
  const boxes = random.shuffle(mask.rectangles(BOX, BOX)).map(box => ({ x: Math.round(box.x / mask.cellSize), y: Math.round(box.y / mask.cellSize) }));
  for (const { x, y } of boxes) {
    const sides = random.shuffle(SIDES);
    const inBox = (i: number, j: number) => i >= x && i < x + BOX && j >= y && j < y + BOX;
    let blocked = false;
    for (let j = y; j < y + BOX && !blocked; j++) for (let i = x; i < x + BOX && !blocked; i++) blocked = approach.has(key(i, j));
    if (blocked) continue;
    // A convex box with a clear ring a hunter wide can't divide the yard: a route through it goes round.
    let ring = true;
    for (let j = y - BODY; j < y + BOX + BODY && ring; j++) for (let i = x - BODY; i < x + BOX + BODY && ring; i++) ring = mask.has(i, j);
    const yard = ring ? empty : label(inBox);
    // Entrances stay in the yard, since the box is off every approach. Those the empty region joined must stay joined.
    const joined = new Map<number, number | undefined>();
    let divided = false;
    for (const e of ring ? [] : entrances) {
      const before = empty.get(e)!;
      if (!joined.has(before)) joined.set(before, yard.get(e));
      else divided ||= joined.get(before) !== yard.get(e);
    }
    if (divided) continue;
    const reached = new Set(entrances.map(e => yard.get(e)));
    const door = sides.find(side => {
      const step = side === 'N' ? key(x + 1, y - BODY) : side === 'S' ? key(x + 1, y + BOX) : side === 'W' ? key(x - BODY, y + 1) : key(x + BOX, y + 1);
      return yard.has(step) && (!entrances.length || reached.has(yard.get(step)));
    });
    if (door) return { x, y, door };
  }
  return undefined;
}

/**
 * The house in its box's local world units: four walls, a door on `door`, and a window on
 * the opposite wall, each a doorway wide (52's worked case) and centred. It encloses, so it
 * has a roof.
 */
function house(size: number, door: Side): ElementTemplate {
  const span = BOX * size;
  const parts: ElementTemplate['parts'] = [];
  const gates: ElementTemplate['parts'] = [];
  for (const side of SIDES) {
    const horizontal = side === 'N' || side === 'S';
    // North and south walls run the full span; east and west fit between them.
    const run = horizontal ? { axis: 'h' as const, x: 0, y: side === 'N' ? 0 : BOX, length: BOX }
      : { axis: 'v' as const, x: side === 'W' ? 0 : BOX, y: 0, length: BOX };
    const emitted = emitWallRun(run, { cellSize: size, thickness: WALL, offset: side === 'N' || side === 'W' ? 0 : -WALL,
      trimStart: horizontal ? 0 : WALL, trimEnd: horizontal ? 0 : WALL,
      openings: side === door ? [{ center: BOX / 2, length: CELL_SCALE.doorway, kind: 'door' }]
        : side === OPPOSITE[door] ? [{ center: BOX / 2, length: CELL_SCALE.doorway, kind: 'window' }] : [] });
    parts.push(...emitted.filter(part => part.part === 'obstacle'));
    gates.push(...emitted.filter(part => part.part === 'gate'));
  }
  parts.push(...gates);
  return { w: span, h: span, encloses: true, parts };
}
