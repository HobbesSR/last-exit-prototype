import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    c = f.read()

old_prop = """
export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[]): boolean {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < grid.length; i++) {
      const cell = grid[i]!;
      if (cell.domain.length === 0) return false;

      // Check Orthogonal Edges
      const checkSide = (neighborOffset: number, mySide: Side, neighborSide: Side) => {
        const nCell = grid[i + neighborOffset]!;
        const newDomain = cell.domain.filter(opt => nCell.domain.some(nOpt => matchEdge(opt, mySide, nOpt, neighborSide, libraryTiles)));
        if (newDomain.length < cell.domain.length) {
          cell.domain = newDomain;
          changed = true;
        }
      };

      if (cell.y > 0) checkSide(-columns, "N", "S");
      if (cell.y < rows - 1) checkSide(columns, "S", "N");
      if (cell.x > 0) checkSide(-1, "W", "E");
      if (cell.x < columns - 1) checkSide(1, "E", "W");
      
      if (cell.domain.length === 0) return false;
      
      // Check Vertices (Top-Left corner of this cell)
      if (cell.x > 0 && cell.y > 0) {
        const tlCell = grid[i - columns - 1]!;
        const trCell = grid[i - columns]!;
        const blCell = grid[i - 1]!;
"""

new_prop = """
export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[]): boolean {
  const cellMap = new Map<string, WfcCell>();
  for (const c of grid) cellMap.set(`${c.x},${c.y}`, c);

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < grid.length; i++) {
      const cell = grid[i]!;
      if (cell.domain.length === 0) return false;

      const checkSide = (nx: number, ny: number, mySide: Side, neighborSide: Side) => {
        const nCell = cellMap.get(`${nx},${ny}`);
        if (!nCell) return;
        const newDomain = cell.domain.filter(opt => nCell.domain.some(nOpt => matchEdge(opt, mySide, nOpt, neighborSide, libraryTiles)));
        if (newDomain.length < cell.domain.length) {
          cell.domain = newDomain;
          changed = true;
        }
      };

      checkSide(cell.x, cell.y - 1, "N", "S");
      checkSide(cell.x, cell.y + 1, "S", "N");
      checkSide(cell.x - 1, cell.y, "W", "E");
      checkSide(cell.x + 1, cell.y, "E", "W");
      
      if (cell.domain.length === 0) return false;
      
      // Check Vertices (Top-Left corner of this cell)
      const tlCell = cellMap.get(`${cell.x - 1},${cell.y - 1}`);
      const trCell = cellMap.get(`${cell.x},${cell.y - 1}`);
      const blCell = cellMap.get(`${cell.x - 1},${cell.y}`);
      
      if (tlCell && trCell && blCell) {
"""
c = c.replace(old_prop.strip(), new_prop.strip())
with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(c)
