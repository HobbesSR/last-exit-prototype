with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

start_idx = wfc.find('export function matchVertex')
end_idx = wfc.find('export function propagate')

if start_idx != -1 and end_idx != -1:
    new_matchVertex = """export function matchVertex(options: (TileOption | null)[], libraryTiles: TileDesign[]): boolean {
  // options is [TL, TR, BL, BR] surrounding a single vertex point
  // The vertex is where 4 segment boundaries meet:
  // 1. TL's South segment 5
  // 2. TL's East segment 5
  // 3. BL's East segment 0
  // 4. TR's South segment 0
  const required = new Set<string>();
  
  const addReq = (opt: TileOption, side: Side, index: number) => {
    const segs = getRotatedEdge(opt, side, libraryTiles);
    const seg = segs[index];
    if (seg && seg !== "any") required.add(seg);
  };

  if (options[0]) {
    addReq(options[0], "S", 5);
    addReq(options[0], "E", 5);
  }
  if (options[1]) {
    addReq(options[1], "S", 0);
    // TR's West segment 5 is identical to TL's East segment 5, no need to add if WFC matches edges,
    // but we add it to be safe in case TL is null.
    addReq(options[1], "W", 5);
  }
  if (options[2]) {
    addReq(options[2], "E", 0);
    addReq(options[2], "N", 5);
  }
  if (options[3]) {
    addReq(options[3], "N", 0);
    addReq(options[3], "W", 0);
  }
  
  return required.size <= 1;
}

"""
    wfc = wfc[:start_idx] + new_matchVertex + wfc[end_idx:]
    with open("src/wfc.ts", "w", encoding="utf-8") as f:
        f.write(wfc)
    print("SUCCESS")
else:
    print("FAILED")
