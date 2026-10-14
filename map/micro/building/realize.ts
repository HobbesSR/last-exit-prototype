import { isCellSize } from '../../kernel/scale.ts';
import type { ElementRoof, ElementTemplate } from '../../../shared/map/element.ts';
import { ROOF_OVERHANG } from '../../../shared/view.ts';
import { deriveBuildingBoundaries } from './boundaries.ts';
import type { BuildingBoundary } from './boundaries.ts';
import { OUTSIDE, validateBuildingDesign } from './design.ts';
import type { BuildingAllocation, BuildingDesign, BuildingSide } from './design.ts';
import { placeBuildingOpenings, sameBuildingRun } from './openings.ts';
import type { BuildingOpeningResult, BuildingRunLimits, PlacedBuildingOpening } from './openings.ts';
import { emitWallRun } from './walls.ts';
import type { BuildingRoofGroups } from './groups.ts';

export interface BuildingRealizationOptions {
  cellSize: number;
  /** In cells; at most one cell, so inward perimeter walls remain contained. */
  thickness?: number;
  /** Whether the building has a roof (defaults to true). */
  encloses?: boolean;
  /** Spaces that get a roof; defaults to all spaces if encloses is true. */
  roofed?: readonly string[];
  /**
   * Fade groups, scoped to each placement of the template: one for all its roofs, or one per
   * space (`reachableRoofGroups` fills that). A roof spanning spaces takes their one group; a
   * roof with no group fades alone.
   */
  groupId?: string | BuildingRoofGroups;
  /** Stable exterior assembly order, followed by internal boundaries. */
  exteriorOrder?: readonly BuildingSide[];
  /** Horizontal perimeter walls own convex corners; otherwise walls overlap there. */
  corners?: 'horizontal' | 'overlap';
  /**
   * Spaces kept clear to their whole cells, such as a passage a doorway wide. A wall one shares
   * with a space not listed stands wholly in that space instead of straddling the boundary.
   */
  clear?: readonly string[];
  /** Opening widths by connection id, in cells; others are a doorway (`placeBuildingOpenings`). */
  widths?: Record<string, number>;
}
export interface BuildingRealization extends BuildingOpeningResult {
  boundaries: BuildingBoundary[];
  issues: string[];
  /** Anchor in world units; template geometry is local to this point. */
  origin?: { x: number; y: number };
  template?: ElementTemplate;
  /** The boundary each of the template's parts stands on, by index: its two owners. */
  owners?: { a: string; b: string }[];
}

/** Realize supplied ownership. It never allocates cells or checks the region's portal promise. */
export function realizeBuilding(design: BuildingDesign, allocation: BuildingAllocation, options: BuildingRealizationOptions): BuildingRealization {
  const result: BuildingRealization = { boundaries: [], openings: [], misses: [], issues: validateBuildingDesign(design) };
  const thickness = options.thickness ?? 0.25, encloses = options.encloses ?? true;
  if (!isCellSize(options.cellSize) || !Number.isFinite(thickness) || thickness <= 0 || thickness > 1)
    result.issues.push('A building needs an integer cell size and wall thickness in (0, 1].');
  if (options.corners !== undefined && !['horizontal', 'overlap'].includes(options.corners)) result.issues.push('Invalid corner ownership.');
  const order = options.exteriorOrder ?? ['N', 'E', 'S', 'W'];
  if (order.length !== 4 || new Set(order).size !== 4 || order.some(side => !['N', 'E', 'S', 'W'].includes(side)))
    result.issues.push('Exterior order must contain each side once.');
  const ids = new Set(design.spaces.map(space => space.id));
  for (const space of allocation.spaces) if (!ids.has(space.id)) result.issues.push(`Unknown allocated space: ${space.id}`);
  // A design space may have no cells: its connections become reported misses, not contracts.
  if (result.issues.length) return result;
  try { result.boundaries = deriveBuildingBoundaries(allocation); }
  catch (error) { result.issues.push(error instanceof Error ? error.message : String(error)); return result; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of allocation.footprint) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + 1); y1 = Math.max(y1, c.y + 1); }
  const isRectangular = (x1 - x0) * (y1 - y0) === allocation.footprint.length;
  let roofCells: readonly { x: number; y: number }[] = [];
  if (options.roofed) {
    const roofSpaces = new Set(options.roofed);
    roofCells = allocation.spaces.filter(s => roofSpaces.has(s.id)).flatMap(s => s.cells);
  } else if (encloses) {
    roofCells = allocation.footprint;
  }
  const cells = new Set(allocation.footprint.map(c => `${c.x},${c.y}`));
  const owner = new Map(allocation.spaces.flatMap(space => space.cells.map(c => [`${c.x},${c.y}`, space.id] as const)));
  const clear = new Set(options.clear ?? []);
  // An interior wall straddles its guide, unless one side is kept clear and the other isn't: then it stands in the other.
  const interiorOffset = (run: BuildingBoundary['runs'][number]) => {
    const before = (i: number) => owner.get(run.axis === 'h' ? `${run.x + i},${run.y - 1}` : `${run.x - 1},${run.y + i}`);
    const after = (i: number) => owner.get(run.axis === 'h' ? `${run.x + i},${run.y}` : `${run.x},${run.y + i}`);
    const a = before(0), b = after(0);
    for (let i = 1; i < run.length; i++) if (before(i) !== a || after(i) !== b) return -thickness / 2;
    return clear.has(a!) === clear.has(b!) ? -thickness / 2 : clear.has(a!) ? 0 : -thickness;
  };
  const walls: (BuildingRunLimits & { offset: number; side: BuildingSide | null; extendStart: number; extendEnd: number })[] = [];
  for (const pair of result.boundaries) pair.runs.forEach((run, i) => {
    const side = pair.runSides[i]!;
    const offset = side === 'N' || side === 'W' ? 0 : side === 'S' || side === 'E' ? -thickness : interiorOffset(run);
    let trimStart = 0, trimEnd = 0, extendStart = 0, extendEnd = 0;
    if (options.corners === 'horizontal' && (side === 'E' || side === 'W')) {
      const insideX = run.x - (side === 'E' ? 1 : 0);
      if (!cells.has(`${insideX},${run.y - 1}`)) trimStart = thickness;
      if (!cells.has(`${insideX},${run.y + run.length}`)) trimEnd = thickness;
    }
    // At a concave corner the two inward walls would meet only at a point. The horizontal wall
    // owns that corner in either mode, reaching into the footprint cell beyond its run.
    if (side === 'N' || side === 'S') {
      const inside = side === 'S' ? run.y - 1 : run.y, outside = side === 'S' ? run.y : run.y - 1;
      const concave = (x: number) => cells.has(`${x},${inside}`) && cells.has(`${x},${outside}`);
      if (concave(run.x - 1)) extendStart = thickness;
      if (concave(run.x + run.length)) extendEnd = thickness;
    }
    walls.push({ a: pair.a, b: pair.b, run, side, offset, trimStart, trimEnd, extendStart, extendEnd });
  });
  if (walls.some(wall => wall.trimStart + wall.trimEnd > wall.run.length)) {
    result.issues.push('Corner trims consume a wall run.'); return result;
  }
  Object.assign(result, placeBuildingOpenings(design, result.boundaries, { limits: walls, ...(options.widths ? { widths: options.widths } : {}) }));
  walls.sort((a, b) => (a.side === null ? 4 : order.indexOf(a.side)) - (b.side === null ? 4 : order.indexOf(b.side)));
  const parts: ElementTemplate['parts'] = [], gates: ElementTemplate['parts'] = [];
  const partOwners: { a: string; b: string }[] = [], gateOwners: { a: string; b: string }[] = [];
  for (const wall of walls) {
    const openings = result.openings.filter(opening => opening.a === wall.a && opening.b === wall.b && sameBuildingRun(opening.run, wall.run))
      .map(opening => ({ ...opening, center: opening.center + wall.extendStart }));
    const emitted = emitWallRun({ ...wall.run, x: wall.run.x - x0 - wall.extendStart, y: wall.run.y - y0, length: wall.run.length + wall.extendStart + wall.extendEnd },
      { cellSize: options.cellSize, thickness, offset: wall.offset, trimStart: wall.trimStart, trimEnd: wall.trimEnd, openings });
    for (const part of emitted) {
      (part.part === 'gate' ? gates : parts).push(part);
      (part.part === 'gate' ? gateOwners : partOwners).push({ a: wall.a, b: wall.b });
    }
  }
  parts.push(...gates);
  result.owners = [...partOwners, ...gateOwners];
  result.origin = { x: x0 * options.cellSize, y: y0 * options.cellSize };
  const roofs = deriveContiguousRoofs(roofCells, x0, y0, options.cellSize, typeof options.groupId === 'string' ? options.groupId : undefined, result.openings);
  const groups = options.groupId;
  if (groups && typeof groups !== 'string') for (const roof of roofs) {
    const named = new Set(roof.cells.map(c => groups[owner.get(`${c.x + x0},${c.y + y0}`)!]));
    if (named.size > 1) { result.issues.push(`A roof spans spaces in different fade groups: ${roof.id}`); return result; }
    const [group] = named;
    if (group !== undefined) roof.groupId = group;
  }
  result.template = {
    w: (x1 - x0) * options.cellSize,
    h: (y1 - y0) * options.cellSize,
    encloses: encloses && isRectangular,
    parts,
    ...(roofs.length ? { roofs } : {}),
  };
  return result;
}

/**
 * Partition roofed cells into contiguous components (4-neighbor connectivity), deriving
 * bounding boxes, exterior overhangs, and threshold cells from exterior door openings.
 */
export function deriveContiguousRoofs(
  cells: readonly { x: number; y: number }[],
  x0: number,
  y0: number,
  cellSize: number,
  groupId?: string,
  openings: readonly PlacedBuildingOpening[] = [],
): ElementRoof[] {
  if (!cells.length) return [];
  const sortedCells = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const cellSet = new Set(sortedCells.map(c => `${c.x},${c.y}`));
  const visited = new Set<string>();
  const components: { x: number; y: number }[][] = [];

  for (const c of sortedCells) {
    const k = `${c.x},${c.y}`;
    if (visited.has(k)) continue;
    const comp: { x: number; y: number }[] = [];
    const queue = [c];
    visited.add(k);
    while (queue.length) {
      const curr = queue.pop()!;
      comp.push(curr);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = curr.x + dx, ny = curr.y + dy, nk = `${nx},${ny}`;
        if (cellSet.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push({ x: nx, y: ny });
        }
      }
    }
    comp.sort((a, b) => a.y - b.y || a.x - b.x);
    components.push(comp);
  }
  components.sort((a, b) => a[0]!.y - b[0]!.y || a[0]!.x - b[0]!.x);

  return components.map((comp, idx) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of comp) {
      minX = Math.min(minX, c.x - x0);
      minY = Math.min(minY, c.y - y0);
      maxX = Math.max(maxX, c.x - x0);
      maxY = Math.max(maxY, c.y - y0);
    }
    const bounds = {
      x: minX * cellSize,
      y: minY * cellSize,
      w: (maxX - minX + 1) * cellSize,
      h: (maxY - minY + 1) * cellSize,
    };
    const compSet = new Set(comp.map(c => `${c.x},${c.y}`));
    const thresholds: { x: number; y: number }[] = [];
    const seenThreshold = new Set<string>();

    for (const op of openings) {
      if (op.kind !== 'door') continue;
      if (op.a !== OUTSIDE && op.b !== OUTSIDE) continue;
      const run = op.run;
      const start = Math.floor(op.center - op.length / 2);
      const end = Math.ceil(op.center + op.length / 2);
      for (let i = start; i < end; i++) {
        const rx = run.axis === 'h' ? run.x + i : run.x;
        const ry = run.axis === 'v' ? run.y + i : run.y;
        let inX = rx, inY = ry, outX = rx, outY = ry;
        if (run.axis === 'h') {
          if (cellSet.has(`${rx},${ry - 1}`)) { inY = ry - 1; outY = ry; }
          else { inY = ry; outY = ry - 1; }
        } else {
          if (cellSet.has(`${rx - 1},${ry}`)) { inX = rx - 1; outX = rx; }
          else { inX = rx; outX = rx - 1; }
        }
        if (compSet.has(`${inX},${inY}`)) {
          const tk = `${outX - x0},${outY - y0}`;
          if (!seenThreshold.has(tk)) {
            seenThreshold.add(tk);
            thresholds.push({ x: outX - x0, y: outY - y0 });
          }
        }
      }
    }

    return {
      id: `roof-${idx + 1}`,
      ...(groupId ? { groupId } : {}),
      bounds,
      cellSize,
      origin: { x: 0, y: 0 },
      cells: comp.map(c => ({ x: c.x - x0, y: c.y - y0 })),
      overhang: ROOF_OVERHANG,
      ...(thresholds.length ? { thresholds } : {}),
    };
  });
}
