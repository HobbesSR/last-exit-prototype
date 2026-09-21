with open("src/core.ts", "r", encoding="utf-8") as f:
    code = f.read()

code = code.replace(
    'import { getDifficulty, solveWfc } from "./wfc.ts";',
    'import { getDifficulty, solveWfc, getRotatedEdge } from "./wfc.ts";'
)

injection = """
      const composition = composeMacro({
        version: 1, seed: seedText, width: p.columns * p.tileSize, height: p.rows * p.tileSize,
        mask: cellMask, defaultCellClass: "grass", placements: placementsArray,
      });

      const W = composition.width;
      const H = composition.height;
      const cellConstraints = new Array(W * H).fill("any");
      
      for (const t of tiles) {
        const opt = { templateId: t.templateId, orientation: t.orientation };
        const N = getRotatedEdge(opt, "N", library.tiles);
        const S = getRotatedEdge(opt, "S", library.tiles);
        const E = getRotatedEdge(opt, "E", library.tiles);
        const W_edge = getRotatedEdge(opt, "W", library.tiles);
        
        for (let i = 0; i < p.tileSize; i++) {
          if (N[i] !== "any") {
            const cx = t.x + i; const cy = t.y - 1;
            if (cy >= 0) cellConstraints[cy * W + cx] = N[i];
          }
          if (S[i] !== "any") {
            const cx = t.x + i; const cy = t.y + p.tileSize;
            if (cy < H) cellConstraints[cy * W + cx] = S[i];
          }
          if (E[i] !== "any") {
            const cx = t.x + p.tileSize; const cy = t.y + i;
            if (cx < W) cellConstraints[cy * W + cx] = E[i];
          }
          if (W_edge[i] !== "any") {
            const cx = t.x - 1; const cy = t.y + i;
            if (cx >= 0) cellConstraints[cy * W + cx] = W_edge[i];
          }
        }
      }
      
      const adaptedEffective = [...composition.effectiveCellClass];
      for (let i = 0; i < adaptedEffective.length; i++) {
        // ONLY if it was originally 'any'
        if (composition.cellClass[i] === "any") {
          if (cellConstraints[i] !== "any") {
            adaptedEffective[i] = cellConstraints[i];
          }
        }
      }
      composition.effectiveCellClass = adaptedEffective;
"""

code = code.replace(
    """      const composition = composeMacro({
        version: 1, seed: seedText, width: p.columns * p.tileSize, height: p.rows * p.tileSize,
        mask: cellMask, defaultCellClass: "grass", placements: placementsArray,
      });""",
    injection
)

# And also we need to export originalCellClass to app.ts. We can just encode it.
code = code.replace(
    'class: encodeGrid(grid.cellClass),',
    'class: encodeGrid(grid.cellClass),\n          originalClass: encodeGrid(composition.cellClass),'
)

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(code)
print("core updated")
