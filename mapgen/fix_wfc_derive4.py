with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

start_idx = wfc.find('export function matchVertex')
end_idx = wfc.find('export function propagate')

if start_idx != -1 and end_idx != -1:
    new_matchVertex = """export function matchVertex(options: (TileOption | null)[], libraryTiles: TileDesign[]): boolean {
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
}

"""
    wfc = wfc[:start_idx] + new_matchVertex + wfc[end_idx:]
    with open("src/wfc.ts", "w", encoding="utf-8") as f:
        f.write(wfc)
    print("SUCCESS")
else:
    print("FAILED")
