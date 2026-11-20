import type { Box, Cell, CollisionMap, PlayableArea, World } from './types.ts';

/** Cover a world rectangle with whole playable cells, including its partial edge cells. */
export function openPlayableArea(width: World, height: World, cellSize: World): PlayableArea {
  const cols = Math.ceil(width / cellSize);
  return { cellSize, rows: Array.from({ length: Math.ceil(height / cellSize) }, (_, y) => ({ y, runs: [[0, cols]] })) };
}

/** Encode distinct occupied grid cells, preserving holes and concave outlines in row-major order. */
export function playableAreaFromCells(cells: Iterable<Cell>, cellSize: World): PlayableArea {
  const rows = new Map<number, number[]>();
  for (const { x, y } of cells) {
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y)!.push(x);
  }
  return { cellSize, rows: [...rows].sort(([a], [b]) => a - b).map(([y, cells]) => {
    const runs: [number, number][] = [];
    for (const x of cells.sort((a, b) => a - b)) {
      const last = runs.at(-1);
      if (last && last[1] === x) last[1]++;
      else runs.push([x, x + 1]);
    }
    return { y, runs };
  }) };
}

/** Read playable ground as world rectangles in stored row/run order, without exposing its encoding. */
export function* playableAreaRects(area: PlayableArea): Generator<Box> {
  const { cellSize, rows } = area;
  for (const row of rows) for (const [start, end] of row.runs)
    yield { x: start * cellSize, y: row.y * cellSize, w: (end - start) * cellSize, h: cellSize };
}

// Reading the area by cell, for collision and anything else asking whether a place is on the map. The rows
// are indexed once per area, keyed by the area object.
const playableRows = new WeakMap<PlayableArea, Map<number, Array<[number, number]>>>();
/** Whether grid cell `col`,`row` is playable ground. */
export function occupiedCell(area: PlayableArea, col: number, row: number): boolean {
  let rows = playableRows.get(area);
  if (!rows) { rows = new Map(area.rows.map(entry => [entry.y, entry.runs])); playableRows.set(area, rows); }
  const runs = rows.get(row);
  if (!runs) return false;
  // Runs are ordered and disjoint in the map contract.
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid][1] <= col) lo = mid + 1; else hi = mid;
  }
  return lo < runs.length && runs[lo][0] <= col;
}
/**
 * The playable area as one byte per cell of the map's grid, row-major, nonzero where the cell is playable:
 * what `occupiedCell` answers for every cell `insideMap` can ask about, for the Rust core (#1233).
 */
export function playableCells(map: Pick<CollisionMap, 'width' | 'height' | 'playableArea'>): { cellSize: World; cols: number; rows: number; occupied: Uint8Array } {
  const area = playableAreaOf(map), cellSize = area.cellSize;
  const cols = Math.ceil(map.width / cellSize), rows = Math.ceil(map.height / cellSize), occupied = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) occupied[row * cols + col] = occupiedCell(area, col, row) ? 1 : 0;
  return { cellSize, cols, rows, occupied };
}
/** The map's playable area. Every match map has one; a map without it is rejected rather than bounded by a default shape. */
export function playableAreaOf(map: Pick<CollisionMap, 'playableArea'>): PlayableArea {
  if (!map.playableArea) throw new RangeError('Map has no playableArea');
  return map.playableArea;
}
/** Whether a disk of `radius` at `x`,`y` lies wholly on the map's playable ground. */
export function insideMap(map: Pick<CollisionMap, 'width' | 'height' | 'playableArea'>, x: World, y: World, radius: World = 0): boolean {
  const area = playableAreaOf(map), size = area.cellSize;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius < 0
    || x - radius < 0 || y - radius < 0 || x + radius > map.width || y + radius > map.height
    || x >= map.width || y >= map.height) return false;
  if (radius === 0) return occupiedCell(area, Math.floor(x / size), Math.floor(y / size));
  const left = Math.max(0, Math.floor((x - radius) / size));
  const right = Math.min(Math.ceil(map.width / size) - 1, Math.floor((x + radius) / size));
  const top = Math.max(0, Math.floor((y - radius) / size));
  const bottom = Math.min(Math.ceil(map.height / size) - 1, Math.floor((y + radius) / size));
  for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
    if (occupiedCell(area, col, row)) continue;
    const nearX = Math.max(col * size, Math.min((col + 1) * size, x));
    const nearY = Math.max(row * size, Math.min((row + 1) * size, y));
    const ex = x - nearX, ey = y - nearY;
    if (ex * ex + ey * ey < radius * radius) return false;
  }
  return true;
}
