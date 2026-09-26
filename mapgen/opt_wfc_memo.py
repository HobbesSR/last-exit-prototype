import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# Let's just memoize matchEdge!
new_code = """
const matchEdgeCache = new Map<string, boolean>();
export function matchEdge(a: TileOption, sideA: Side, b: TileOption, sideB: Side, library: TileDesign[]): boolean {
  const key = `${a.templateId}:${a.orientation}:${sideA}|${b.templateId}:${b.orientation}:${sideB}`;
  if (matchEdgeCache.has(key)) return matchEdgeCache.get(key)!;
  const res = _matchEdge(a, sideA, b, sideB, library);
  matchEdgeCache.set(key, res);
  return res;
}
function _matchEdge(a: TileOption, sideA: Side, b: TileOption, sideB: Side, library: TileDesign[]): boolean {
"""
wfc = wfc.replace(
    'export function matchEdge(a: TileOption, sideA: Side, b: TileOption, sideB: Side, library: TileDesign[]): boolean {',
    new_code.strip()
)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
