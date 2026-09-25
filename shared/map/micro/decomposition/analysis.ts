/** Pure, bounded grid analysis for decomposition proposals. Maximal rectangles are capped at 256. */
import type { Cell } from '../types.ts';
import type { BoundaryEdge, CellRect, NeckCut, RegionAnalysis } from './types.ts';

const LIMIT = 4096;
const SPAN = 64;
const DIRS = [[0, -1], [-1, 0], [1, 0], [0, 1]] as const;
const edgeDirections = [
  { dx: 0, dy: -1, a: (x: number, y: number): Cell => ({ x, y }), b: (x: number, y: number): Cell => ({ x: x + 1, y }) },
  { dx: 1, dy: 0, a: (x: number, y: number): Cell => ({ x: x + 1, y }), b: (x: number, y: number): Cell => ({ x: x + 1, y: y + 1 }) },
  { dx: 0, dy: 1, a: (x: number, y: number): Cell => ({ x: x + 1, y: y + 1 }), b: (x: number, y: number): Cell => ({ x, y: y + 1 }) },
  { dx: -1, dy: 0, a: (x: number, y: number): Cell => ({ x, y: y + 1 }), b: (x: number, y: number): Cell => ({ x, y }) },
] as const;

export function cellKey(cell: Cell): string { return `${cell.x},${cell.y}`; }
const compareCells = (a: Cell, b: Cell) => a.y - b.y || a.x - b.x;
const copy = (cell: Cell): Cell => ({ x: cell.x, y: cell.y });

/** Validate and return row-major copies, so callers' input objects and ordering are never retained. */
export function canonicalCells(cells: readonly Cell[]): Cell[] {
  if (cells.length > LIMIT) throw new Error(`A region supports at most ${LIMIT} cells`);
  const seen = new Set<string>();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const cell of cells) {
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || Math.abs(cell.x) > 512 || Math.abs(cell.y) > 512) throw new Error('Cell coordinates must be integer values in [-512, 512]');
    const key = cellKey(cell);
    if (seen.has(key)) throw new Error(`Duplicate cell ${key}`);
    seen.add(key); minX = Math.min(minX, cell.x); maxX = Math.max(maxX, cell.x); minY = Math.min(minY, cell.y); maxY = Math.max(maxY, cell.y);
  }
  if (cells.length && (maxX - minX + 1 > SPAN || maxY - minY + 1 > SPAN)) throw new Error(`A region may span at most ${SPAN} cells per axis`);
  return cells.map(copy).sort(compareCells);
}

/** cells must already be canonical; this is kept allocation-light for articulation checks. */
function componentsFromCanonical(cells: readonly Cell[], blocked = new Set<string>()): Cell[][] {
  const own = new Set(cells.map(cellKey)), seen = new Set<string>(), result: Cell[][] = [];
  for (const start of cells) {
    const startKey = cellKey(start);
    if (blocked.has(startKey) || seen.has(startKey)) continue;
    const queue = [start]; seen.add(startKey); const part: Cell[] = [];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]; part.push(copy(current));
      for (const [dx, dy] of DIRS) {
        const next = { x: current.x + dx, y: current.y + dy }, key = cellKey(next);
        if (own.has(key) && !blocked.has(key) && !seen.has(key)) { seen.add(key); queue.push(next); }
      }
    }
    result.push(part.sort(compareCells));
  }
  return result.sort((a, b) => compareCells(a[0], b[0]));
}

export function connectedComponents(cells: readonly Cell[]): Cell[][] { return componentsFromCanonical(canonicalCells(cells)); }

function emptyTopology(cells: Cell[], own: Set<string>, bounds: CellRect): { holes: Cell[][]; outside: Set<string> } {
  if (!cells.length) return { holes: [], outside: new Set() };
  const minX = bounds.x - 1, maxX = bounds.x + bounds.w, minY = bounds.y - 1, maxY = bounds.y + bounds.h;
  const outside = new Set<string>(), queue: Cell[] = [{ x: minX, y: minY }]; outside.add(cellKey(queue[0]));
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    for (const [dx, dy] of DIRS) {
      const n = { x: c.x + dx, y: c.y + dy }, key = cellKey(n);
      if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY && !own.has(key) && !outside.has(key)) { outside.add(key); queue.push(n); }
    }
  }
  const holes: Cell[][] = [], visited = new Set(outside);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const first = { x, y }, firstKey = cellKey(first);
    if (own.has(firstKey) || visited.has(firstKey)) continue;
    const part: Cell[] = [], pending = [first]; visited.add(firstKey);
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]; part.push(c);
      for (const [dx, dy] of DIRS) { const n = { x: c.x + dx, y: c.y + dy }, key = cellKey(n); if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY && !own.has(key) && !visited.has(key)) { visited.add(key); pending.push(n); } }
    }
    holes.push(part.sort(compareCells));
  }
  return { holes: holes.sort((a, b) => compareCells(a[0], b[0])), outside };
}

function maximalRectangles(cells: Cell[], bounds: CellRect): CellRect[] {
  if (!cells.length) return [];
  const own = new Set(cells.map(cellKey)), found = new Map<string, CellRect>();
  const has = (x: number, y: number) => own.has(`${x},${y}`);
  for (let top = bounds.y; top < bounds.y + bounds.h; top++) {
    const present = Array.from({ length: bounds.w }, (_, i) => has(bounds.x + i, top));
    for (let bottom = top; bottom < bounds.y + bounds.h; bottom++) {
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
  return [...found.values()].sort((a, b) => b.area - a.area || a.y - b.y || a.x - b.x || a.h - b.h || a.w - b.w).slice(0, 256);
}

export function analyzeRegion(input: readonly Cell[]): RegionAnalysis {
  const cells = canonicalCells(input);
  const bounds: CellRect = cells.length ? (() => { const xs = cells.map(c => c.x), ys = cells.map(c => c.y); const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x + 1, h = Math.max(...ys) - y + 1; return { x, y, w, h, area: w * h }; })() : { x: 0, y: 0, w: 0, h: 0, area: 0 };
  const own = new Set(cells.map(cellKey)), { holes } = emptyTopology(cells, own, bounds);
  const holeKeys = new Set(holes.flat().map(cellKey));
  const boundary: BoundaryEdge[] = [];
  for (const cell of cells) for (const side of edgeDirections) {
    const neighbor = { x: cell.x + side.dx, y: cell.y + side.dy }, key = cellKey(neighbor);
    if (!own.has(key)) boundary.push({ a: side.a(cell.x, cell.y), b: side.b(cell.x, cell.y), cell: copy(cell), kind: holeKeys.has(key) ? 'hole' : 'outer' });
  }
  const depthMap = new Map<string, number>(), queue: Cell[] = [];
  for (const edge of boundary) { const key = cellKey(edge.cell); if (!depthMap.has(key)) { depthMap.set(key, 1); queue.push(edge.cell); } }
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of DIRS) { const n = { x: queue[i].x + dx, y: queue[i].y + dy }, key = cellKey(n); if (own.has(key) && !depthMap.has(key)) { depthMap.set(key, depthMap.get(cellKey(queue[i]))! + 1); queue.push(n); } }
  const rowRuns = new Map<string, number>(), colRuns = new Map<string, number>();
  for (const cell of cells) { let horizontal = 1, vertical = 1; for (let x = cell.x - 1; own.has(`${x},${cell.y}`); x--) horizontal++; for (let x = cell.x + 1; own.has(`${x},${cell.y}`); x++) horizontal++; for (let y = cell.y - 1; own.has(`${cell.x},${y}`); y--) vertical++; for (let y = cell.y + 1; own.has(`${cell.x},${y}`); y++) vertical++; rowRuns.set(cellKey(cell), horizontal); colRuns.set(cellKey(cell), vertical); }
  const xMonotone = (() => { const rows = new Map<number, number[]>(); for (const c of cells) rows.set(c.y, [...(rows.get(c.y) ?? []), c.x]); return [...rows.values()].every(xs => Math.max(...xs) - Math.min(...xs) + 1 === xs.length); })();
  const yMonotone = (() => { const cols = new Map<number, number[]>(); for (const c of cells) cols.set(c.x, [...(cols.get(c.x) ?? []), c.y]); return [...cols.values()].every(ys => Math.max(...ys) - Math.min(...ys) + 1 === ys.length); })();
  const components = componentsFromCanonical(cells);
  // Iterative Tarjan DFS: recursive traversal can overflow on a 4,096-cell corridor.
  const discovery = new Map<string, number>(), low = new Map<string, number>(), parent = new Map<string, string | null>(), children = new Map<string, number>(), articulation = new Set<string>();
  let time = 0;
  for (const root of cells) {
    const rootKey = cellKey(root); if (discovery.has(rootKey)) continue;
    discovery.set(rootKey, ++time); low.set(rootKey, time); parent.set(rootKey, null); children.set(rootKey, 0);
    const stack: Array<{ cell: Cell; next: number }> = [{ cell: root, next: 0 }];
    while (stack.length) {
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
  return { cells, area: cells.length, bounds, components, holes, boundary, perimeter: boundary.length, rectangularity: bounds.area ? cells.length / bounds.area : 0, xMonotone, yMonotone, depth: cells.map(cell => ({ cell: copy(cell), distance: depthMap.get(cellKey(cell)) ?? 0 })), localWidth: cells.map(cell => ({ cell: copy(cell), width: Math.min(rowRuns.get(cellKey(cell))!, colRuns.get(cellKey(cell))!) })), articulationCells: articulationCells.sort(compareCells), maximalRectangles: maximalRectangles(cells, bounds) };
}

export function findNeckCuts(input: readonly Cell[], options: { maxWidth?: number; minComponentArea?: number; limit?: number } = {}): NeckCut[] {
  const cells = canonicalCells(input), maxWidth = options.maxWidth ?? 3, minArea = options.minComponentArea ?? 8, limit = options.limit ?? 64;
  if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > SPAN || !Number.isInteger(minArea) || minArea < 1 || minArea > LIMIT || !Number.isInteger(limit) || limit < 0 || limit > 64) throw new Error('Neck cut options must be bounded integers (width 1..64, area 1..4096, limit 0..64)');
  const own = new Set(cells.map(cellKey)), initialComponents = componentsFromCanonical(cells), candidates: Array<{ cells: Cell[]; orientation: 'horizontal' | 'vertical' }> = [];
  for (const orientation of ['horizontal', 'vertical'] as const) {
    const dx = orientation === 'horizontal' ? 1 : 0, dy = orientation === 'vertical' ? 1 : 0;
    for (const cell of cells) {
      // A candidate is the entire cross-section, never an arbitrary subrun.
      if (own.has(`${cell.x - dx},${cell.y - dy}`)) continue;
      const run: Cell[] = [];
      for (let x = cell.x, y = cell.y; own.has(`${x},${y}`); x += dx, y += dy) run.push({ x, y });
      if (run.length <= maxWidth) candidates.push({ cells: run, orientation });
    }
  }
  const cuts: Array<NeckCut & { imbalance: number }> = [];
  for (const candidate of candidates) {
    const components = componentsFromCanonical(cells, new Set(candidate.cells.map(cellKey)));
    if (components.length <= initialComponents.length || components.some(part => part.length < minArea)) continue;
    const areas = components.map(part => part.length), max = Math.max(...areas), min = Math.min(...areas);
    const first = candidate.cells[0];
    cuts.push({ id: `neck-${candidate.orientation === 'horizontal' ? 'h' : 'v'}-${first.x}-${first.y}-${candidate.cells.length}`, cells: candidate.cells.map(copy), orientation: candidate.orientation, components, resultingAreas: areas, imbalance: max - min });
  }
  return cuts.sort((a, b) => a.imbalance - b.imbalance || a.cells.length - b.cells.length || a.cells[0].y - b.cells[0].y || a.cells[0].x - b.cells[0].x || a.orientation.localeCompare(b.orientation)).slice(0, limit).map(({ imbalance: _imbalance, ...cut }) => cut);
}

export function growRegion(input: readonly Cell[], seeds: readonly Cell[], options: { maxArea?: number; eligible?: (cell: Cell) => boolean; cost?: (cell: Cell) => number } = {}): Cell[] {
  const cells = canonicalCells(input), own = new Set(cells.map(cellKey)), normalizedSeeds = canonicalCells(seeds);
  if (!normalizedSeeds.every(seed => own.has(cellKey(seed)))) throw new Error('Growth seeds must be cells in the region');
  if (options.eligible && !normalizedSeeds.every(seed => options.eligible!(copy(seed)))) throw new Error('Growth seeds must be eligible');
  const maxArea = options.maxArea ?? cells.length;
  if (!Number.isInteger(maxArea) || maxArea < 0 || maxArea > LIMIT || normalizedSeeds.length > maxArea) throw new Error('maxArea must accommodate seeds and be at most 4096');
  const selected = new Map(normalizedSeeds.map(c => [cellKey(c), c])), frontier = new Map<string, Cell>();
  const addNeighbors = (cell: Cell) => { for (const [dx, dy] of DIRS) { const next = { x: cell.x + dx, y: cell.y + dy }, key = cellKey(next); if (own.has(key) && !selected.has(key) && !frontier.has(key) && (options.eligible?.(copy(next)) ?? true)) frontier.set(key, next); } };
  for (const seed of normalizedSeeds) addNeighbors(seed);
  while (selected.size < maxArea && frontier.size) {
    const ranked = [...frontier.values()].map(cell => { const cost = options.cost?.(copy(cell)) ?? 0; if (!Number.isFinite(cost)) throw new Error('Growth costs must be finite'); return { cell, cost }; }).sort((a, b) => a.cost - b.cost || compareCells(a.cell, b.cell));
    const next = ranked[0].cell; frontier.delete(cellKey(next)); selected.set(cellKey(next), next); addNeighbors(next);
  }
  return [...selected.values()].map(copy).sort(compareCells);
}

export function shortestCellPath(input: readonly Cell[], from: Cell, to: Cell): Cell[] | null {
  const cells = canonicalCells(input), own = new Set(cells.map(cellKey)), start = cellKey(from), end = cellKey(to);
  if (!own.has(start) || !own.has(end)) return null;
  const queue = [copy(from)], previous = new Map<string, Cell | null>([[start, null]]);
  for (let i = 0; i < queue.length && !previous.has(end); i++) for (const [dx, dy] of DIRS) { const next = { x: queue[i].x + dx, y: queue[i].y + dy }, key = cellKey(next); if (own.has(key) && !previous.has(key)) { previous.set(key, queue[i]); queue.push(next); } }
  if (!previous.has(end)) return null;
  const path: Cell[] = []; for (let current: Cell | null = copy(to); current; current = previous.get(cellKey(current)) ?? null) path.push(copy(current));
  return path.reverse();
}
