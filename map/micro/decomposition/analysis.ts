/** Pure, bounded grid analysis for decomposition proposals. Maximal rectangles are capped at 256. */
import { cellKey, compareCells } from '../../kernel/cell.ts';
import type { Cell } from '../types.ts';
import type { BoundaryEdge, CellRect, NeckCut, RegionAnalysis } from './types.ts';

import { WorkBudget } from './work-budget.ts';
export { WorkBudget, WorkBudgetExceededError, createWorkBudget, DEFAULT_WORK_LIMIT } from './work-budget.ts';

// Charge a deterministic size-based allowance before native sorting/copying.
function sorted<T>(values: T[], compare: (a: T, b: T) => number, budget: WorkBudget): T[] {
  budget.spend(values.length * (1 + Math.ceil(Math.log2(Math.max(1, values.length)))));
  return values.sort(compare);
}
const DIRS = [[0, -1], [-1, 0], [1, 0], [0, 1]] as const;
const edgeDirections = [
  { dx: 0, dy: -1, a: (x: number, y: number): Cell => ({ x, y }), b: (x: number, y: number): Cell => ({ x: x + 1, y }) },
  { dx: 1, dy: 0, a: (x: number, y: number): Cell => ({ x: x + 1, y }), b: (x: number, y: number): Cell => ({ x: x + 1, y: y + 1 }) },
  { dx: 0, dy: 1, a: (x: number, y: number): Cell => ({ x: x + 1, y: y + 1 }), b: (x: number, y: number): Cell => ({ x, y: y + 1 }) },
  { dx: -1, dy: 0, a: (x: number, y: number): Cell => ({ x, y: y + 1 }), b: (x: number, y: number): Cell => ({ x, y }) },
] as const;

export { cellKey };
const copy = (cell: Cell): Cell => ({ x: cell.x, y: cell.y });

/** Validate and return row-major copies, so callers' input objects and ordering are never retained. */
export function canonicalCells(cells: readonly Cell[], budget = new WorkBudget()): Cell[] {
  // Reserve validation/copy and sorting before allocating any input-sized copies.
  budget.spend(cells.length * (3 + Math.ceil(Math.log2(Math.max(1, cells.length)))));
  const seen = new Set<string>();
  for (const cell of cells) {
    // Position does not affect analysis cost; retain only the representation
    // guard needed by neighbor probes, outside flood cells and their neighbors.
    if (![cell.x, cell.y].every(n => Number.isSafeInteger(n)
      && Number.isSafeInteger(n - 2) && Number.isSafeInteger(n + 2)))
      throw new Error('Cell coordinates must be safe integers with representable analysis offsets');
    const key = cellKey(cell);
    if (seen.has(key)) throw new Error(`Duplicate cell ${key}`);
    seen.add(key);
  }
  return cells.map(copy).sort(compareCells);
}

/** cells must already be canonical; this is kept allocation-light for articulation checks. */
function componentsFromCanonical(cells: readonly Cell[], budget: WorkBudget, blocked = new Set<string>()): Cell[][] {
  budget.spend(cells.length * 2);
  const own = new Set(cells.map(cellKey)), seen = new Set<string>(), result: Cell[][] = [];
  for (const start of cells) {
    const startKey = cellKey(start);
    if (blocked.has(startKey) || seen.has(startKey)) continue;
    const queue = [start]; seen.add(startKey); const part: Cell[] = [];
    for (let i = 0; i < queue.length; i++) {
      budget.spend(5); const current = queue[i]; part.push(copy(current));
      for (const [dx, dy] of DIRS) {
        const next = { x: current.x + dx, y: current.y + dy }, key = cellKey(next);
        if (own.has(key) && !blocked.has(key) && !seen.has(key)) { seen.add(key); queue.push(next); }
      }
    }
    result.push(sorted(part, compareCells, budget));
  }
  return sorted(result, (a, b) => compareCells(a[0], b[0]), budget);
}

export function connectedComponents(cells: readonly Cell[], budget = new WorkBudget()): Cell[][] { return componentsFromCanonical(canonicalCells(cells, budget), budget); }

function emptyTopology(cells: Cell[], own: Set<string>, bounds: CellRect, budget: WorkBudget): { holes: Cell[][]; outside: Set<string> } {
  if (!cells.length) return { holes: [], outside: new Set() };
  const minX = bounds.x - 1, maxX = bounds.x + bounds.w, minY = bounds.y - 1, maxY = bounds.y + bounds.h;
  const outside = new Set<string>(), queue: Cell[] = [{ x: minX, y: minY }]; outside.add(cellKey(queue[0]));
  for (let i = 0; i < queue.length; i++) {
    budget.spend(4); const c = queue[i];
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy }, key = cellKey(n);
      if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY && !own.has(key) && !outside.has(key)) { outside.add(key); queue.push(n); }
    }
  }
  // Holes are the components of the empty cells the outside flood never reached, gathered in canonical order.
  budget.spend((bounds.w + 2) * (bounds.h + 2));
  const enclosed: Cell[] = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const key = `${x},${y}`;
    if (!own.has(key) && !outside.has(key)) enclosed.push({ x, y });
  }
  return { holes: componentsFromCanonical(enclosed, budget), outside };
}

function maximalRectangles(cells: Cell[], bounds: CellRect, budget: WorkBudget): CellRect[] {
  budget.spend(cells.length);
  if (!cells.length) return [];
  const own = new Set(cells.map(cellKey)), found = new Map<string, CellRect>();
  const has = (x: number, y: number) => own.has(`${x},${y}`);
  for (let top = bounds.y; top < bounds.y + bounds.h; top++) {
    budget.spend(bounds.w);
    const present = Array.from({ length: bounds.w }, (_, i) => has(bounds.x + i, top));
    for (let bottom = top; bottom < bounds.y + bounds.h; bottom++) {
      // Intersection, run discovery and maximality probes are all linear in width.
      budget.spend(bounds.w * 5);
      if (bottom > top) for (let i = 0; i < present.length; i++) present[i] = present[i] && has(bounds.x + i, bottom);
      for (let i = 0; i < present.length;) {
        if (!present[i]) { i++; continue; }
        const left = i; while (i < present.length && present[i]) i++; const right = i - 1;
        const x = bounds.x + left, w = right - left + 1, h = bottom - top + 1;
        let above = top > bounds.y, below = bottom < bounds.y + bounds.h - 1;
        for (let dx = 0; dx < w; dx++) { above &&= has(x + dx, top - 1); below &&= has(x + dx, bottom + 1); }
        if (!above && !below) { const rect = { x, y: top, w, h, area: w * h }; found.set(`${x},${top},${w},${h}`, rect); }
      }
    }
  }
  return sorted([...found.values()], (a, b) => b.area - a.area || a.y - b.y || a.x - b.x || a.h - b.h || a.w - b.w, budget).slice(0, 256);
}

export function analyzeRegion(input: readonly Cell[], budget = new WorkBudget()): RegionAnalysis {
  const cells = canonicalCells(input, budget);
  // Fixed allowance for bounded linear passes: bounds, membership, boundaries,
  // boundary seeds, run setup, monotonicity, articulation output and metadata.
  // Variable floods, run lengths, DFS and rectangles are charged separately.
  budget.spend(cells.length * 20);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const cell of cells) { minX = Math.min(minX, cell.x); maxX = Math.max(maxX, cell.x); minY = Math.min(minY, cell.y); maxY = Math.max(maxY, cell.y); }
  const bounds: CellRect = cells.length ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area: (maxX - minX + 1) * (maxY - minY + 1) } : { x: 0, y: 0, w: 0, h: 0, area: 0 };
  // Refuse unaffordable sparse boxes before the outside flood allocates cells.
  budget.spend(cells.length ? (bounds.w + 2) * (bounds.h + 2) : 0);
  const own = new Set(cells.map(cellKey)), { holes } = emptyTopology(cells, own, bounds, budget);
  const holeKeys = new Set(holes.flat().map(cellKey));
  const boundary: BoundaryEdge[] = [];
  for (const cell of cells) for (const side of edgeDirections) {
    const neighbor = { x: cell.x + side.dx, y: cell.y + side.dy }, key = cellKey(neighbor);
    if (!own.has(key)) boundary.push({ a: side.a(cell.x, cell.y), b: side.b(cell.x, cell.y), cell: copy(cell), kind: holeKeys.has(key) ? 'hole' : 'outer' });
  }
  const depthMap = new Map<string, number>(), queue: Cell[] = [];
  for (const edge of boundary) { const key = cellKey(edge.cell); if (!depthMap.has(key)) { depthMap.set(key, 1); queue.push(edge.cell); } }
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of DIRS) { budget.spend(); const n = { x: queue[i].x + dx, y: queue[i].y + dy }, key = cellKey(n); if (own.has(key) && !depthMap.has(key)) { depthMap.set(key, depthMap.get(cellKey(queue[i]))! + 1); queue.push(n); } }
  const rowRuns = new Map<string, number>(), colRuns = new Map<string, number>();
  for (const cell of cells) { let horizontal = 1, vertical = 1; for (let x = cell.x - 1; own.has(`${x},${cell.y}`); x--) { budget.spend(); horizontal++; } for (let x = cell.x + 1; own.has(`${x},${cell.y}`); x++) { budget.spend(); horizontal++; } for (let y = cell.y - 1; own.has(`${cell.x},${y}`); y--) { budget.spend(); vertical++; } for (let y = cell.y + 1; own.has(`${cell.x},${y}`); y++) { budget.spend(); vertical++; } rowRuns.set(cellKey(cell), horizontal); colRuns.set(cellKey(cell), vertical); }
  const monotone = (axis: 'x' | 'y'): boolean => {
    const runs = new Map<number, { min: number; max: number; count: number }>();
    for (const cell of cells) { const key = axis === 'x' ? cell.y : cell.x, value = cell[axis], run = runs.get(key); if (run) { run.min = Math.min(run.min, value); run.max = Math.max(run.max, value); run.count++; } else runs.set(key, { min: value, max: value, count: 1 }); }
    return [...runs.values()].every(run => run.max - run.min + 1 === run.count);
  };
  const xMonotone = monotone('x'), yMonotone = monotone('y');
  const components = componentsFromCanonical(cells, budget);
  // Iterative Tarjan DFS avoids stack overflow on long corridors.
  const discovery = new Map<string, number>(), low = new Map<string, number>(), parent = new Map<string, string | null>(), children = new Map<string, number>(), articulation = new Set<string>();
  let time = 0;
  for (const root of cells) {
    const rootKey = cellKey(root); if (discovery.has(rootKey)) continue;
    discovery.set(rootKey, ++time); low.set(rootKey, time); parent.set(rootKey, null); children.set(rootKey, 0);
    const stack: Array<{ cell: Cell; next: number }> = [{ cell: root, next: 0 }];
    while (stack.length) {
      budget.spend();
      const frame = stack[stack.length - 1], currentKey = cellKey(frame.cell);
      if (frame.next < DIRS.length) {
        const [dx, dy] = DIRS[frame.next++], next = { x: frame.cell.x + dx, y: frame.cell.y + dy }, nextKey = cellKey(next);
        if (!own.has(nextKey)) continue;
        if (!discovery.has(nextKey)) {
          parent.set(nextKey, currentKey); children.set(currentKey, (children.get(currentKey) ?? 0) + 1);
          discovery.set(nextKey, ++time); low.set(nextKey, time); children.set(nextKey, 0); stack.push({ cell: next, next: 0 });
        } else if (nextKey !== parent.get(currentKey)) low.set(currentKey, Math.min(low.get(currentKey)!, discovery.get(nextKey)!));
        continue;
      }
      stack.pop();
      const parentKey = parent.get(currentKey);
      if (parentKey === null) { if ((children.get(currentKey) ?? 0) > 1) articulation.add(currentKey); }
      else if (parentKey) {
        low.set(parentKey, Math.min(low.get(parentKey)!, low.get(currentKey)!));
        if (parent.get(parentKey) !== null && low.get(currentKey)! >= discovery.get(parentKey)!) articulation.add(parentKey);
      }
    }
  }
  const articulationCells = cells.filter(cell => articulation.has(cellKey(cell))).map(copy);
  return { cells, area: cells.length, bounds, components, holes, boundary, perimeter: boundary.length, rectangularity: bounds.area ? cells.length / bounds.area : 0, xMonotone, yMonotone, depth: cells.map(cell => ({ cell: copy(cell), distance: depthMap.get(cellKey(cell)) ?? 0 })), localWidth: cells.map(cell => ({ cell: copy(cell), width: Math.min(rowRuns.get(cellKey(cell))!, colRuns.get(cellKey(cell))!) })), articulationCells: sorted(articulationCells, compareCells, budget), maximalRectangles: maximalRectangles(cells, bounds, budget) };
}

export function findNeckCuts(input: readonly Cell[], options: { maxWidth?: number; minComponentArea?: number; limit?: number } = {}, budget = new WorkBudget()): NeckCut[] {
  const cells = canonicalCells(input, budget), maxWidth = options.maxWidth ?? 3, minArea = options.minComponentArea ?? 8, limit = options.limit ?? 64;
  if (!Number.isSafeInteger(maxWidth) || maxWidth < 1 || !Number.isSafeInteger(minArea) || minArea < 1 || !Number.isSafeInteger(limit) || limit < 0) throw new Error('Neck cut options must be safe integers (positive width and area, nonnegative limit)');
  budget.spend(cells.length * 4);
  const own = new Set(cells.map(cellKey)), initialComponents = componentsFromCanonical(cells, budget), candidates: Array<{ cells: Cell[]; orientation: 'horizontal' | 'vertical' }> = [];
  for (const orientation of ['horizontal', 'vertical'] as const) {
    const dx = orientation === 'horizontal' ? 1 : 0, dy = orientation === 'vertical' ? 1 : 0;
    for (const cell of cells) {
      // A candidate is the entire cross-section, never an arbitrary subrun.
      if (own.has(`${cell.x - dx},${cell.y - dy}`)) continue;
      const run: Cell[] = [];
      for (let x = cell.x, y = cell.y; own.has(`${x},${y}`); x += dx, y += dy) { budget.spend(); run.push({ x, y }); }
      if (run.length <= maxWidth) candidates.push({ cells: run, orientation });
    }
  }
  const cuts: Array<NeckCut & { imbalance: number }> = [];
  for (const candidate of candidates) {
    budget.spend(candidate.cells.length);
    const components = componentsFromCanonical(cells, budget, new Set(candidate.cells.map(cellKey)));
    if (components.length <= initialComponents.length || components.some(part => part.length < minArea)) continue;
    const areas = components.map(part => part.length);
    let max = 0, min = Infinity; for (const area of areas) { max = Math.max(max, area); min = Math.min(min, area); }
    budget.spend(components.length + candidate.cells.length);
    const first = candidate.cells[0];
    cuts.push({ id: `neck-${candidate.orientation === 'horizontal' ? 'h' : 'v'}-${first.x}-${first.y}-${candidate.cells.length}`, cells: candidate.cells.map(copy), orientation: candidate.orientation, components, resultingAreas: areas, imbalance: max - min });
  }
  return sorted(cuts, (a, b) => a.imbalance - b.imbalance || a.cells.length - b.cells.length || a.cells[0].y - b.cells[0].y || a.cells[0].x - b.cells[0].x || a.orientation.localeCompare(b.orientation), budget).slice(0, limit).map(({ imbalance: _imbalance, ...cut }) => cut);
}

export function growRegion(input: readonly Cell[], seeds: readonly Cell[], options: { maxArea?: number; eligible?: (cell: Cell) => boolean; cost?: (cell: Cell) => number } = {}, budget = new WorkBudget()): Cell[] {
  const cells = canonicalCells(input, budget), normalizedSeeds = canonicalCells(seeds, budget);
  budget.spend(cells.length + normalizedSeeds.length * 4);
  const own = new Set(cells.map(cellKey));
  if (!normalizedSeeds.every(seed => own.has(cellKey(seed)))) throw new Error('Growth seeds must be cells in the region');
  if (options.eligible && !normalizedSeeds.every(seed => options.eligible!(copy(seed)))) throw new Error('Growth seeds must be eligible');
  const maxArea = options.maxArea ?? cells.length;
  if (!Number.isSafeInteger(maxArea) || maxArea < 0 || normalizedSeeds.length > maxArea) throw new Error('maxArea must be a nonnegative safe integer accommodating seeds');
  const selected = new Map(normalizedSeeds.map(c => [cellKey(c), c])), frontier = new Map<string, Cell>();
  const addNeighbors = (cell: Cell) => { for (const [dx, dy] of DIRS) { budget.spend(); const next = { x: cell.x + dx, y: cell.y + dy }, key = cellKey(next); if (own.has(key) && !selected.has(key) && !frontier.has(key) && (options.eligible?.(copy(next)) ?? true)) frontier.set(key, next); } };
  for (const seed of normalizedSeeds) addNeighbors(seed);
  while (selected.size < maxArea && frontier.size) {
    budget.spend(frontier.size);
    const ranked = sorted([...frontier.values()].map(cell => { const cost = options.cost?.(copy(cell)) ?? 0; if (!Number.isFinite(cost)) throw new Error('Growth costs must be finite'); return { cell, cost }; }), (a, b) => a.cost - b.cost || compareCells(a.cell, b.cell), budget);
    const next = ranked[0].cell; frontier.delete(cellKey(next)); selected.set(cellKey(next), next); addNeighbors(next);
  }
  budget.spend(selected.size);
  return sorted([...selected.values()].map(copy), compareCells, budget);
}

export function shortestCellPath(input: readonly Cell[], from: Cell, to: Cell, budget = new WorkBudget()): Cell[] | null {
  const cells = canonicalCells(input, budget);
  budget.spend(cells.length);
  const own = new Set(cells.map(cellKey)), start = cellKey(from), end = cellKey(to);
  if (!own.has(start) || !own.has(end)) return null;
  const queue = [copy(from)], previous = new Map<string, Cell | null>([[start, null]]);
  for (let i = 0; i < queue.length && !previous.has(end); i++) for (const [dx, dy] of DIRS) { budget.spend(); const next = { x: queue[i].x + dx, y: queue[i].y + dy }, key = cellKey(next); if (own.has(key) && !previous.has(key)) { previous.set(key, queue[i]); queue.push(next); } }
  if (!previous.has(end)) return null;
  const path: Cell[] = []; for (let current: Cell | null = copy(to); current; current = previous.get(cellKey(current)) ?? null) { budget.spend(); path.push(copy(current)); }
  return path.reverse();
}
