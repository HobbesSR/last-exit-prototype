import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# First, add getRotatedCells
getRotatedCells_logic = """export function getRotatedCells(opt: TileOption, side: Side, libraryTiles: TileDesign[]): string[] {
  const design = libraryTiles.find(t => t.id === opt.templateId)!;
  const rotIdx = opt.orientation / 90;
  const targetIdx = SIDES.indexOf(side);
  const sourceIdx = (targetIdx - rotIdx + 4) % 4;
  const sourceSide = SIDES[sourceIdx]!;

  const def: string[] = [];
  if (design.cells) {
    const getMark = (x: number, y: number) => {
      const c = design.cells![y]?.[x] || ".";
      if (c === ".") return design.defaultCellClass || "any";
      return design.legend?.[c] || "any";
    };
    if (sourceSide === "N") {
      for (let x = 0; x < 6; x++) def.push(getMark(x, 0));
    } else if (sourceSide === "S") {
      for (let x = 0; x < 6; x++) def.push(getMark(x, 5));
    } else if (sourceSide === "W") {
      for (let y = 0; y < 6; y++) def.push(getMark(0, y));
    } else if (sourceSide === "E") {
      for (let y = 0; y < 6; y++) def.push(getMark(5, y));
    }
  } else {
    for (let i = 0; i < 6; i++) def.push("any");
  }

  let reversed = false;
  if (opt.orientation === 90 && (sourceSide === "E" || sourceSide === "W")) reversed = !reversed;
  if (opt.orientation === 180) reversed = !reversed;
  if (opt.orientation === 270 && (sourceSide === "N" || sourceSide === "S")) reversed = !reversed;
  if (reversed) def.reverse();

  return def;
}
"""

wfc = wfc.replace('export function matchEdge', getRotatedCells_logic + '\nexport function matchEdge')

# Rewrite matchEdge
matchEdge_logic = """export function matchEdge(optA: TileOption, sideA: Side, optB: TileOption, sideB: Side, libraryTiles: TileDesign[]): boolean {
  const segA = getRotatedEdge(optA, sideA, libraryTiles);
  const cellA = getRotatedCells(optA, sideA, libraryTiles);
  const segB = getRotatedEdge(optB, sideB, libraryTiles);
  const cellB = getRotatedCells(optB, sideB, libraryTiles);

  for (let i = 0; i < 6; i++) {
    // A's segment constrains B's cell
    if (segA[i] !== "any" && cellB[i] !== "any" && segA[i] !== cellB[i]) return false;
    // B's segment constrains A's cell
    if (segB[i] !== "any" && cellA[i] !== "any" && segB[i] !== cellA[i]) return false;
  }
  return true;
}"""

wfc = re.sub(r'export function matchEdge.*?return true;\n\}', matchEdge_logic, wfc, flags=re.DOTALL)

# Rewrite matchVertex
matchVertex_logic = """export function matchVertex(options: (TileOption | null)[], libraryTiles: TileDesign[]): boolean {
  // options is [TL, TR, BL, BR] surrounding a single vertex point
  
  const checkCell = (optCell: TileOption | null, sideCell: Side, indexCell: number,
                     optSeg1: TileOption | null, sideSeg1: Side, indexSeg1: number,
                     optSeg2: TileOption | null, sideSeg2: Side, indexSeg2: number) => {
    let cellClass = "any";
    if (optCell) cellClass = getRotatedCells(optCell, sideCell, libraryTiles)[indexCell];
    
    let seg1 = "any";
    if (optSeg1) seg1 = getRotatedEdge(optSeg1, sideSeg1, libraryTiles)[indexSeg1];
    
    let seg2 = "any";
    if (optSeg2) seg2 = getRotatedEdge(optSeg2, sideSeg2, libraryTiles)[indexSeg2];

    const reqs = new Set<string>();
    if (cellClass !== "any") reqs.add(cellClass);
    if (seg1 !== "any") reqs.add(seg1);
    if (seg2 !== "any") reqs.add(seg2);
    
    return reqs.size <= 1;
  };

  const tl = options[0];
  const tr = options[1];
  const bl = options[2];
  const br = options[3];

  // TL cell (S-5, E-5) constrained by BL North-5 and TR West-5
  if (!checkCell(tl, "S", 5, bl, "N", 5, tr, "W", 5)) return false;

  // TR cell (S-0, W-0) constrained by BR North-0 and TL East-0 (wait, East edge goes from y=0 to y=5, so y=0 is index 0. Yes, TL East-0... wait! TR's South-West corner is at y=5! So TR South-0, TR West-5? Let's trace carefully.)
  // TR tile. Bottom-left cell. 
  // South edge goes x=0 to x=5. Bottom-left cell is x=0, index 0.
  // West edge goes y=0 to y=5. Bottom-left cell is y=5, index 5!
  // It is constrained by BR's North segment 0, and TL's East segment 5.
  if (!checkCell(tr, "S", 0, br, "N", 0, tl, "E", 5)) return false;

  // BL tile. Top-right cell.
  // North edge goes x=0 to x=5. Top-right is x=5, index 5.
  // East edge goes y=0 to y=5. Top-right is y=0, index 0.
  // Constrained by TL's South segment 5, and BR's West segment 0.
  if (!checkCell(bl, "N", 5, tl, "S", 5, br, "W", 0)) return false;

  // BR tile. Top-left cell.
  // North edge x=0 to x=5. Top-left is x=0, index 0.
  // West edge y=0 to y=5. Top-left is y=0, index 0.
  // Constrained by TR's South segment 0, and BL's East segment 0.
  if (!checkCell(br, "N", 0, tr, "S", 0, bl, "E", 0)) return false;

  return true;
}"""

wfc = re.sub(r'export function matchVertex.*?return required\.size <= 1;\n\}', matchVertex_logic, wfc, flags=re.DOTALL)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
