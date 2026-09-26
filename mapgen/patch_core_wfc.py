import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

# Add import for Wfc
import_stmt = 'import { WfcGrid, TileOption, getDifficulty, solveWfc } from "./wfc.js";\n'
core = core.replace('import { composeMacro } from "./macro.js";', 'import { composeMacro } from "./macro.js";\n' + import_stmt)

# Locate the filler logic and replace it with WFC
old_filler = """
      // Build a weighted pool of "safe" filler tiles (tiles with NO macro walls)
      const fillers = library.tiles.filter(t => !t.walls || t.walls.length === 0);
      const totalWeight = fillers.reduce((sum, t) => sum + (t.weight !== undefined ? t.weight : 10), 0);

      for (let i = 0; i < cells.length; i++) {
        if (!assigned[i]) {
          let r = random() * totalWeight;
          let chosen = fallbackDesign;
          for (const t of fillers) {
            r -= (t.weight !== undefined ? t.weight : 10);
            if (r <= 0) { chosen = t; break; }
          }
          const orientations = chosen.orientations && chosen.orientations.length ? chosen.orientations : [0];
          const orientation = orientations[Math.floor(random() * orientations.length)]!;
          assigned[i] = { template: chosen, templateId: chosen.id, orientation, anchor: findAnchor(chosen, orientation) };
        }
      }
"""

new_filler = """
      // Build the initial WFC grid
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
          // Initialize domain for unassigned cells based on zone tier
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
core = core.replace(old_filler.strip(), new_filler.strip())

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
