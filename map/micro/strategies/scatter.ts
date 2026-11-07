import { bounds, circle, rect } from '../../../shared/shape.ts';
import { createFillMask, elementShapes, shapesOverlap } from '../geometry.ts';
import { reachPerimeter } from '../perimeter-reach.ts';
import { createProspectiveParcels, type ProspectiveParcels } from '../prospective-parcels.ts';
import { SCATTER_CORD_BUDGET } from '../cord-witness.ts';
import { hunterClearance, portalStands } from '../portals.ts';
import { microMetrics } from '../metrics.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, LootSite, RegionBrief, RegionMask, RegionRandom } from '../types.ts';
import { mergeAssemblies, type SitingCanvas } from '../canvas.ts';
import { placedElements } from '../placeables/placeable.ts';
import type { Placed } from '../placeables/placeable.ts';
import { compareCells } from '../../kernel/cell.ts';
import { buildOpen } from './open.ts';
import { draw } from '../random.ts';
import { builtRegion } from '../result.ts';
export { draw } from '../random.ts';

/** A piece `sitePiecesPerCell` may try at a cell: its name for the label, and how to place it at the origin. */
export interface FallbackPiece { name: string; place(): Placed<unknown> }

/**
 * The bounded fallback a themed strategy tries before leaving viable fill empty (17.2.11, #717):
 * single pieces of its own kind, sited cell by cell rather than on its primary layout. Each fill
 * cell is visited once, in a seeded order, and is taken with chance `density`. A taken cell tries
 * `pieces`' candidates in order and commits the first whose body fits the canvas and keeps `aisle`
 * cells from every committed piece. `pieces` draws the same numbers at every cell, taken or not,
 * so one cell's fate never shifts another's. The canvas carries the strategy's protections, so
 * the portal promise holds as it does for the primary content. Returns the pieces committed.
 */
export function sitePiecesPerCell(canvas: SitingCanvas,random: RegionRandom, density: number, aisle: number, prefix: string,
  pieces: (random: RegionRandom) => FallbackPiece[]): number {
  const size = canvas.fill.cellSize, before = canvas.elements.length;
  for (const cell of random.shuffle([...canvas.fill.cells].sort(compareCells))) {
    const taken = random.next() < density, candidates = pieces(random);
    if (!taken) continue;
    for (const { name, place } of candidates) {
      const placed = place();
      const { w, h } = placed.demand.body;
      const box = rect(cell.x * size, cell.y * size, w * size, h * size);
      if (!canvas.fits(box) || !canvas.spaced(box, aisle * size)) continue;
      if (canvas.commit({ elements: placedElements(placed, `${prefix}-${name}-${canvas.elements.length + 1}`, cell.x, cell.y, size) })) break;
    }
  }
  return canvas.elements.length - before;
}

/** A themed fill too fragmented for structures can still offer zone loot in its usable patches. */
export function unfilledRegion(brief: RegionBrief, channel: number): BuiltRegion {
  const result = buildOpen(brief);
  result.loot = cellLoot(brief, createFillMask(brief), [], channel);
  result.manifest.loot = result.loot.length;
  return result;
}

/*
 * What the strategies that scatter pieces share (54). They keep the portals' approaches clear
 * and place through a live cord (`liveCord`, 20.10), which refuses a piece that would leave a
 * portal stand without a hunter cord, so the portal promise holds as pieces are placed rather
 * than by a check afterwards.
 */

/** A brief parameter from 0 to 1, or `fallback` when the brief doesn't set it. */
export function fraction(brief: RegionBrief, type: string, key: string, fallback: number): number {
  const value = brief.parameters?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(`${type} ${key} must be a number from 0 to 1.`);
  return value;
}

/**
 * A strip over every portal's stands and its threshold crossing: the fixed access anchors
 * (20.10) that stay clear while cords move. One portal carries no route obligation, so it
 * protects nothing. `type` names the region type in what it throws.
 */
export function portalApproaches(brief: RegionBrief, type: string): Shape[] {
  const radius = hunterClearance(brief.cellSize), stands = portalStands(brief);
  const kept: Shape[] = [];
  if (stands.length < 2) return kept;
  for (const { portal, points } of stands) {
    if (!points.length) throw new Error(`${type} portal ${portal.id} is too short for a hunter.`);
    // One strip covers every stand and its threshold crossing, without a
    // protection shape per half-cell sample on a long portal.
    const line = (portal.axis === 'h' ? portal.y : portal.x) * brief.cellSize;
    const start = (portal.axis === 'h' ? portal.x : portal.y) * brief.cellSize;
    kept.push(portal.axis === 'h'
      ? rect(start, line - radius, portal.length * brief.cellSize, 2 * radius)
      : rect(line - radius, start, 2 * radius, portal.length * brief.cellSize));
  }
  return kept;
}

/**
 * A prospective-parcels coordinator (20.10) anchored on `portalApproaches`: it keeps a live hunter
 * cord to every portal stand and refuses a commit that would leave none. Nothing else is reserved
 * between portals, so pieces bend the way through (#759, #787). `type` names the region type in
 * what it throws when the empty shape itself joins no cord.
 */
export function liveCord(brief: RegionBrief, type: string): ProspectiveParcels {
  const parcels = createProspectiveParcels(brief, { fixedAccess: portalApproaches(brief, type), budget: SCATTER_CORD_BUDGET });
  if (!parcels.ok) throw new Error(`${type} region ${brief.id} cannot join its portals in its empty shape (${parcels.reason}).`);
  return parcels.coordinator;
}

/**
 * With the class param `perimeterWalls` (the bundled cover and park classes state it, #838, #849), walls the
 * brief's hinted perimeter through the live cord (`reachPerimeter`, 20.10; 52.1), clear of the
 * portal approaches and the pieces already committed. Returns how many walls stood.
 */
export function perimeterWallsIfAsked(brief: RegionBrief, coordinator: ProspectiveParcels, type: string): number {
  if (brief.parameters?.perimeterWalls !== true) return 0;
  const avoid = [...portalApproaches(brief, type), ...coordinator.elements.flatMap(element => elementShapes(element))];
  return reachPerimeter(coordinator, brief, { kind: 'building', avoid, label: `${type.toLowerCase()}-edge-wall` }).elements.length;
}

/**
 * `region`, finished, with `perimeterWallsIfAsked`'s walls added last, for a builder whose
 * own steps (such as a fallback that runs only when nothing was placed) must not see them
 * (#852 review 669). Its pieces are recommitted through a fresh live cord as one assembly,
 * then the walls are offered; loot a wall now covers is dropped. Past 32 portals, where
 * such builders keep no cord, or if the cord refuses the pieces, the region is unchanged.
 */
export function withPerimeterWalls(brief: RegionBrief, region: BuiltRegion, type: string): BuiltRegion {
  if (brief.parameters?.perimeterWalls !== true || brief.portals.length > 32) return region;
  const coordinator = liveCord(brief, type), pieces = region.elements.map(element => ({ elements: [element] }));
  if (pieces.length && !coordinator.commit(mergeAssemblies(pieces))) return region;
  if (!perimeterWallsIfAsked(brief, coordinator, type)) return region;
  const walls = coordinator.elements.slice(region.elements.length).flatMap(element => elementShapes(element));
  const radius = microMetrics({ cellSize: brief.cellSize, bodyProfile: 'cell' }).lootRadius;
  const loot = region.loot.filter(site => !walls.some(wall => shapesOverlap(wall, circle(site.x, site.y, radius))));
  const rebuilt = builtRegion(brief, [...coordinator.elements], loot, region.coreElements);
  return { ...rebuilt, manifest: { ...region.manifest, ...rebuilt.manifest } };
}

/**
 * Loot at each cell's centre that rolls under its zone's chance (52, "Tier zones"), where a
 * loot disc stays inside the region and clear of every piece. `channel` keeps the roll apart
 * from the strategy's other per-cell draws.
 */
export function cellLoot(brief: RegionBrief, mask: RegionMask, pieces: readonly Shape[], channel: number): LootSite[] {
  const size = brief.cellSize;
  // Each piece is filed under every cell its bounds touch, so a disc tests only its neighbours.
  const near = new Map<string, Shape[]>();
  for (const shape of pieces) {
    const box = bounds(shape);
    for (let y = Math.floor(box.y / size); y < Math.ceil((box.y + box.h) / size); y++)
      for (let x = Math.floor(box.x / size); x < Math.ceil((box.x + box.w) / size); x++) {
        const key = `${x},${y}`, list = near.get(key);
        if (list) list.push(shape); else near.set(key, [shape]);
      }
  }
  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(cell => [`${cell.x},${cell.y}`, zone] as const)));
  const radius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
  const reach = Math.ceil(radius / size - .5);
  const loot: LootSite[] = [];
  for (const cell of mask.cells) {
    const zone = zones.get(`${cell.x},${cell.y}`);
    if (!zone || draw(brief.seed, cell.x, cell.y, channel) >= zone.lootChance) continue;
    const x = (cell.x + .5) * size, y = (cell.y + .5) * size, site = circle(x, y, radius);
    if (!mask.contains(site)) continue;
    let blocked = false;
    for (let dy = -reach; dy <= reach && !blocked; dy++) for (let dx = -reach; dx <= reach; dx++)
      if (near.get(`${cell.x + dx},${cell.y + dy}`)?.some(shape => shapesOverlap(site, shape))) { blocked = true; break; }
    if (!blocked) loot.push({ x, y, tier: zone.tier });
  }
  return loot;
}
