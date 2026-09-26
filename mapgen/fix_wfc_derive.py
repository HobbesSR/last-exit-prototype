import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# Fix getRotatedEdge
getRotatedEdge_logic = """export function getRotatedEdge(opt: TileOption, side: Side, libraryTiles: TileDesign[]): string[] {
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
  }"""

wfc = re.sub(r'export function getRotatedEdge.*?return out;\n  \}', getRotatedEdge_logic, wfc, flags=re.DOTALL)

# Fix matchVertex
matchVertex_logic = """export function matchVertex(options: (TileOption | null)[], libraryTiles: TileDesign[]): boolean {
    // options is [TL, TR, BL, BR] surrounding a single vertex point
    const required = new Set<string>();
    
    const addReq = (opt: TileOption, side: Side, index: number) => {
      const segs = getRotatedEdge(opt, side, libraryTiles);
      const cellClass = segs[index];
      if (cellClass && cellClass !== "any") required.add(cellClass);
    };
  
    if (options[0]) addReq(options[0], "S", 5); // BottomRight cell of TopLeft tile
    if (options[1]) addReq(options[1], "S", 0); // BottomLeft cell of TopRight tile
    if (options[2]) addReq(options[2], "N", 5); // TopRight cell of BottomLeft tile
    if (options[3]) addReq(options[3], "N", 0); // TopLeft cell of BottomRight tile
    
    return required.size <= 1;
  }"""

wfc = re.sub(r'export function matchVertex.*?return required\.size <= 1;\n  \}', matchVertex_logic, wfc, flags=re.DOTALL)

# Also remove the `isVertex` parameter in matchEdge calls if I had any (Wait, matchEdge doesn't use it anymore, getRotatedEdge signature changed).
wfc = wfc.replace('getRotatedEdge(optA, sideA, libraryTiles, false)', 'getRotatedEdge(optA, sideA, libraryTiles)')
wfc = wfc.replace('getRotatedEdge(optB, sideB, libraryTiles, false)', 'getRotatedEdge(optB, sideB, libraryTiles)')


with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
