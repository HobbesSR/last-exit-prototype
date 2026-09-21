import re

with open("src/wfc.ts", "r", encoding="utf-8") as f:
    wfc = f.read()

# I will find the block starting with "// Assign IDs" and ending before "if (!propagate"
wfc = re.sub(r'// Assign IDs and precalculate.*?if \(!propagate', """// Assign IDs and precalculate
    const allOpts = new Set<TileOption>();
    for (let i = 0; i < grid.length; i++) {
      const cell = grid[i]!;
      for (let j = 0; j < cell.domain.length; j++) allOpts.add(cell.domain[j]!);
    }
    const domain = Array.from(allOpts);
    
    let needsPrecalc = false;
    let nextId = 0;
    for (const opt of domain) {
      if (opt.id === undefined) {
        opt.id = nextId++;
        needsPrecalc = true;
      } else {
        if (opt.id >= nextId) nextId = opt.id + 1;
      }
    }

    if (needsPrecalc) {
      for (const opt of domain) {
        (opt as any).validN = new Set();
        (opt as any).validS = new Set();
        (opt as any).validE = new Set();
        (opt as any).validW = new Set();
      }
      for (const opt of domain) {
        for (const nOpt of domain) {
          if (matchEdge(opt, "N", nOpt, "S", libraryTiles)) (opt as any).validN.add(nOpt.id);
          if (matchEdge(opt, "S", nOpt, "N", libraryTiles)) (opt as any).validS.add(nOpt.id);
          if (matchEdge(opt, "E", nOpt, "W", libraryTiles)) (opt as any).validE.add(nOpt.id);
          if (matchEdge(opt, "W", nOpt, "E", libraryTiles)) (opt as any).validW.add(nOpt.id);
        }
      }
    }

    if (!propagate""", wfc, flags=re.DOTALL)

with open("src/wfc.ts", "w", encoding="utf-8") as f:
    f.write(wfc)
