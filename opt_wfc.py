import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    c = f.read()

old_solve = """
export function solveWfc(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], random: () => number): WfcGrid | null {
  if (!propagate(grid, columns, rows, libraryTiles)) return null;

  let minEntropy = Infinity;
  let bestCellIndex = -1;

  for (let i = 0; i < grid.length; i++) {
    const cell = grid[i]!;
    if (cell.domain.length > 1 && cell.domain.length < minEntropy) {
      minEntropy = cell.domain.length;
      bestCellIndex = i;
    }
  }

  // All cells collapsed
  if (bestCellIndex === -1) return grid;

  const cell = grid[bestCellIndex]!;
  
  // Sort options by difficulty (descending) with random jitter
  const options = [...cell.domain].sort((a, b) => {
    return (b.difficulty + random()) - (a.difficulty + random());
  });

  for (const opt of options) {
    const clonedGrid: WfcGrid = grid.map(c => ({
      x: c.x, y: c.y,
      domain: c === cell ? [opt] : [...c.domain]
    }));

    const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random);
    if (result !== null) return result;
  }

  return null;
}
"""

new_solve = """
export function solveWfc(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], random: () => number, depth: number = 0): WfcGrid | null {
  if (!propagate(grid, columns, rows, libraryTiles)) return null;

  let minEntropy = Infinity;
  let bestCellIndex = -1;

  for (let i = 0; i < grid.length; i++) {
    const cell = grid[i]!;
    if (cell.domain.length > 1 && cell.domain.length < minEntropy) {
      minEntropy = cell.domain.length;
      bestCellIndex = i;
    }
  }

  // All cells collapsed
  if (bestCellIndex === -1) return grid;

  const cell = grid[bestCellIndex]!;
  
  // Sort options by difficulty (descending) with random jitter
  const options = [...cell.domain].sort((a, b) => {
    return (b.difficulty + random()) - (a.difficulty + random());
  });

  for (const opt of options) {
    const clonedGrid: WfcGrid = grid.map(c => ({
      x: c.x, y: c.y,
      domain: c === cell ? [opt] : [...c.domain]
    }));

    const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random, depth + 1);
    if (result !== null) return result;
  }

  return null;
}
"""
c = c.replace(old_solve.strip(), new_solve.strip())
with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(c)
