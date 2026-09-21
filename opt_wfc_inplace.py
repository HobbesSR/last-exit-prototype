import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# I'll just change the queue to an array + boolean array for "in queue"
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
      let writeIdx = 0;
      let shrunk = false;
      
      for (let j = 0; j < cell.domain.length; j++) {
        const opt = cell.domain[j]!;
        const validSet = (opt as any)[validProp] as Set<number>;
        let possible = false;
        for (let k = 0; k < nCell.domain.length; k++) {
          if (validSet.has(nCell.domain[k]!.id!)) {
            possible = true;
            break;
          }
        }
        if (possible) {
          cell.domain[writeIdx++] = opt;
        } else {
          shrunk = true;
        }
      }
      
      if (shrunk) {
        cell.domain.length = writeIdx;
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

  // Check diagonals after orthogonal stabilization
"""

wfc = re.sub(r'export function propagate.*?// Check diagonals after orthogonal stabilization', new_propagate.strip() + '\n  // Check diagonals after orthogonal stabilization', wfc, flags=re.DOTALL)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
