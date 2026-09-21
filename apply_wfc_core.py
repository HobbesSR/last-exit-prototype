import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

# Add import
if 'solveWfc' not in core:
    core = core.replace('import { composeMacro } from "./macro.js";', 'import { composeMacro } from "./macro.js";\nimport { WfcGrid, TileOption, getDifficulty, solveWfc } from "./wfc.js";')

old_code = """
    for (let i = 0; i < cells.length; i++) {
      if (!assigned[i]) {
        assigned[i] = { template: fallbackDesign, templateId: fallbackDesign.id, orientation: 0, anchor: findAnchor(fallbackDesign, 0) };
      }
    }
"""

new_code = """
    const wfcGrid: WfcGrid = cells.map((c, i) => {
      if (assigned[i]) {
        return {
          x: c.x, y: c.y,
          domain: [{
            templateId: assigned[i]!.templateId,
            orientation: assigned[i]!.orientation as any,
            difficulty: 0 // pre-assigned
          }]
        };
      } else {
        const tier = zoneOf(c).tier;
        const validTiles = library.tiles.filter(t => !t.eligibleTiers || t.eligibleTiers.includes(tier));
        const domain: TileOption[] = [];
        for (const t of validTiles) {
          const diff = getDifficulty(t);
          const orients = t.orientations && t.orientations.length ? t.orientations : [0];
          for (const o of orients) {
            domain.push({ templateId: t.id, orientation: o as any, difficulty: diff });
          }
        }
        return { x: c.x, y: c.y, domain };
      }
    });

    const solvedGrid = solveWfc(wfcGrid, p.columns, p.rows, library.tiles, random);
    if (!solvedGrid) {
      throw new Error("WFC Solver could not find a valid tile layout for the macro grid.");
    }

    for (let i = 0; i < cells.length; i++) {
      if (!assigned[i]) {
        const opt = solvedGrid[i]!.domain[0]!;
        const template = library.tiles.find(t => t.id === opt.templateId) || fallbackDesign;
        assigned[i] = {
          template,
          templateId: template.id,
          orientation: opt.orientation,
          anchor: findAnchor(template, opt.orientation)
        };
      }
    }
"""

if old_code.strip() in core:
    core = core.replace(old_code.strip(), new_code.strip())
    print("Patched successfully!")
else:
    print("Could not find old code block!")

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
