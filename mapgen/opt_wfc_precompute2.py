import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# I will just write a patch that adds `id?: number` to TileOption, and pre-computes valid neighbors array!
# Actually, the simplest is:
# let optionIdCounter = 0;
# Then assign `id = optionIdCounter++` to each option.
# Then `validEdges[optId][side]` = Set of valid neighbor optIds!

new_code = """
export interface TileOption {
  templateId: string;
  orientation: Orientation;
  difficulty: number;
  weight: number;
  id?: number;
}
"""

wfc = re.sub(r'export interface TileOption \{.*?\n\}', new_code.strip(), wfc, flags=re.DOTALL)

# In solveWfc, we can precalculate:
precalc = """
  // Assign IDs and precalculate valid edges if not done yet
  let needsPrecalc = false;
  if (grid.length > 0 && grid[0]!.domain.length > 0 && grid[0]!.domain[0]!.id === undefined) {
    let id = 0;
    for (const opt of grid[0]!.domain) opt.id = id++;
    needsPrecalc = true;
  }

  if (needsPrecalc) {
    const domain = grid[0]!.domain;
    for (const opt of domain) {
      (opt as any).validN = new Set();
      (opt as any).validS = new Set();
      (opt as any).validE = new Set();
      (opt as any).validW = new Set();
      for (const nOpt of domain) {
        if (_matchEdge(opt, "N", nOpt, "S", libraryTiles)) (opt as any).validN.add(nOpt.id);
        if (_matchEdge(opt, "S", nOpt, "N", libraryTiles)) (opt as any).validS.add(nOpt.id);
        if (_matchEdge(opt, "E", nOpt, "W", libraryTiles)) (opt as any).validE.add(nOpt.id);
        if (_matchEdge(opt, "W", nOpt, "E", libraryTiles)) (opt as any).validW.add(nOpt.id);
      }
    }
  }
"""

# Insert precalc at start of solveWfc
wfc = wfc.replace(
    'if (state.iterations++ > state.maxIterations) return null;',
    'if (state.iterations++ > state.maxIterations) return null;\n' + precalc
)

# In propagate checkSide
new_check = """
      const checkSide = (nIndex: number | undefined, mySide: Side, neighborSide: Side) => {
        if (nIndex === undefined) return;
        const nCell = grid[nIndex]!;
        const validProp = mySide === "N" ? "validN" : mySide === "S" ? "validS" : mySide === "E" ? "validE" : "validW";
        
        const newDomain = cell.domain.filter(opt => {
          const validSet = (opt as any)[validProp] as Set<number>;
          // true if ANY neighbor option is in validSet
          for (let k = 0; k < nCell.domain.length; k++) {
            if (validSet.has(nCell.domain[k]!.id!)) return true;
          }
          return false;
        });
        
        if (newDomain.length < cell.domain.length) {
          cell.domain = newDomain;
          changed = true;
        }
      };
"""

wfc = re.sub(r'const checkSide =.*?changed = true;\n        \}\n      \};', new_check.strip(), wfc, flags=re.DOTALL)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
