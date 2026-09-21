import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# Replace getRotatedEdge ENTIRELY
new_getRotatedEdge = """export function getRotatedEdge(opt: TileOption, side: Side, libraryTiles: TileDesign[]): string[] {
  const design = libraryTiles.find(t => t.id === opt.templateId)!;
  const rotIdx = opt.orientation / 90;
  const targetIdx = SIDES.indexOf(side);
  const sourceIdx = (targetIdx - rotIdx + 4) % 4;
  const sourceSide = SIDES[sourceIdx]!;

  const def: string[] = [];
  if (design.edges && Array.isArray(design.edges[sourceSide])) {
    const segs = design.edges[sourceSide];
    for (const s of segs) def.push(s);
    while (def.length < 6) def.push("any");
  } else if (design.cells) {
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

wfc = re.sub(r'export function getRotatedEdge\(.*?\): \nstring\[\] \{.*?return out;\n  \}', new_getRotatedEdge, wfc, flags=re.DOTALL)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
