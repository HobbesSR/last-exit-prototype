import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

new_propagate = """
export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[]): boolean {
  // Use AC-3 with a queue of indices to process
  const queue = new Set<number>();
  for (let i = 0; i < grid.length; i++) queue.add(i);

  while (queue.size > 0) {
    const i = queue.values().next().value;
    queue.delete(i);
    const cell = grid[i]!;
    if (cell.domain.length === 0) return false;

    const checkSide = (nIndex: number | undefined, mySide: Side, neighborSide: Side) => {
      if (nIndex === undefined) return;
      const nCell = grid[nIndex]!;
      if (!nCell) return;
      const validProp = mySide === "N" ? "validN" : mySide === "S" ? "validS" : mySide === "E" ? "validE" : "validW";
      
      const newDomain = cell.domain.filter(opt => {
        const validSet = (opt as any)[validProp] as Set<number>;
        for (let k = 0; k < nCell.domain.length; k++) {
          if (validSet.has(nCell.domain[k]!.id!)) return true;
        }
        return false;
      });
      
      if (newDomain.length < cell.domain.length) {
        cell.domain = newDomain;
        // If THIS cell shrank, its neighbors need to be re-evaluated against THIS cell!
        if (cell.n !== undefined) queue.add(cell.n);
        if (cell.s !== undefined) queue.add(cell.s);
        if (cell.e !== undefined) queue.add(cell.e);
        if (cell.w !== undefined) queue.add(cell.w);
      }
    };

    checkSide(cell.n, "N", "S");
    checkSide(cell.s, "S", "N");
    checkSide(cell.e, "E", "W");
    checkSide(cell.w, "W", "E");
  }

  // Check diagonals after orthogonal stabilization
"""

wfc = re.sub(r'export function propagate.*?// Check diagonals after orthogonal stabilization', new_propagate.strip() + '\n  // Check diagonals after orthogonal stabilization', wfc, flags=re.DOTALL)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
