import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    c = f.read()

new_wfc = c.replace(
"""
export interface WfcCell {
  x: number;
  y: number;
  domain: TileOption[];
}
""",
"""
export interface WfcCell {
  x: number;
  y: number;
  domain: TileOption[];
  n?: number;
  s?: number;
  e?: number;
  w?: number;
  tl?: number;
  tr?: number;
  bl?: number;
}
"""
)

old_prop = """
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
        const newDomain = cell.domain.filter(brOpt => {
          return tlCell.domain.some(tlOpt => 
            trCell.domain.some(trOpt => 
              blCell.domain.some(blOpt => 
                matchVertex([tlOpt, trOpt, blOpt, brOpt], libraryTiles)
              )
            )
          );
        });
        if (newDomain.length < cell.domain.length) { cell.domain = newDomain; changed = true; }
      }
      
      // We don't need to check all 4 corners for this cell explicitly right now, 
      // because scanning top-left for every cell inherently covers every internal vertex exactly once.
      // However, we DO need to ensure that the adjacent cells respond.
      // So we just rely on the full sweep checking all TL corners. 
    }
  }
  return true;
}
"""

new_prop = """
export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[]): boolean {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < grid.length; i++) {
      const cell = grid[i]!;
      if (cell.domain.length === 0) return false;

      const checkSide = (nIndex: number | undefined, mySide: Side, neighborSide: Side) => {
        if (nIndex === undefined) return;
        const nCell = grid[nIndex]!;
        const newDomain = cell.domain.filter(opt => nCell.domain.some(nOpt => matchEdge(opt, mySide, nOpt, neighborSide, libraryTiles)));
        if (newDomain.length < cell.domain.length) {
          cell.domain = newDomain;
          changed = true;
        }
      };

      checkSide(cell.n, "N", "S");
      checkSide(cell.s, "S", "N");
      checkSide(cell.w, "W", "E");
      checkSide(cell.e, "E", "W");
      
      if (cell.domain.length === 0) return false;
      
      if (cell.tl !== undefined && cell.tr !== undefined && cell.bl !== undefined) {
        const tlCell = grid[cell.tl]!;
        const trCell = grid[cell.tr]!;
        const blCell = grid[cell.bl]!;
        
        const newDomain = cell.domain.filter(brOpt => {
          return tlCell.domain.some(tlOpt => 
            trCell.domain.some(trOpt => 
              blCell.domain.some(blOpt => 
                matchVertex([tlOpt, trOpt, blOpt, brOpt], libraryTiles)
              )
            )
          );
        });
        if (newDomain.length < cell.domain.length) { cell.domain = newDomain; changed = true; }
      }
    }
  }
  return true;
}
"""

new_wfc = new_wfc.replace(old_prop.strip(), new_prop.strip())

new_wfc = new_wfc.replace(
"""
    const clonedGrid: WfcGrid = grid.map(c => ({
      x: c.x, y: c.y,
      domain: c === cell ? [opt] : [...c.domain]
    }));
""",
"""
    const clonedGrid: WfcGrid = grid.map(c => ({
      x: c.x, y: c.y,
      n: c.n, s: c.s, e: c.e, w: c.w, tl: c.tl, tr: c.tr, bl: c.bl,
      domain: c === cell ? [opt] : [...c.domain]
    }));
"""
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(new_wfc)
