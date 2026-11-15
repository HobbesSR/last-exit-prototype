import type { Box, Cell, PlayableArea, World } from './types.ts';

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
