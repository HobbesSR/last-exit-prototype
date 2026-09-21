import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

new_propagate = """
export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], startQueue?: number): boolean {
  const inQueue = new Uint8Array(grid.length);
  const queue: number[] = [];
  
  if (startQueue === undefined) {
    for (let i = 0; i < grid.length; i++) {
      queue.push(i);
      inQueue[i] = 1;
    }
  } else {
    queue.push(startQueue);
    inQueue[startQueue] = 1;
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    inQueue[i] = 0;
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
        if (cell.n !== undefined && !inQueue[cell.n]) { queue.push(cell.n); inQueue[cell.n] = 1; }
        if (cell.s !== undefined && !inQueue[cell.s]) { queue.push(cell.s); inQueue[cell.s] = 1; }
        if (cell.e !== undefined && !inQueue[cell.e]) { queue.push(cell.e); inQueue[cell.e] = 1; }
        if (cell.w !== undefined && !inQueue[cell.w]) { queue.push(cell.w); inQueue[cell.w] = 1; }
      }
    };

    checkSide(cell.n, "N", "S");
    checkSide(cell.s, "S", "N");
    checkSide(cell.e, "E", "W");
    checkSide(cell.w, "W", "E");
  }

  return true;
}
"""

wfc = re.sub(r'export function propagate.*?return true;\n\}', new_propagate.strip() + '\n', wfc, flags=re.DOTALL)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
