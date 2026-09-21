import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

old_filler = """
      for (let i = 0; i < cells.length; i++) {
        if (!assigned[i]) {
          assigned[i] = { template: fallbackDesign, templateId: fallbackDesign.id, orientation: 0, anchor: findAnchor(fallbackDesign, 0) };
        }
      }
"""

new_filler = """
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

core = core.replace(old_filler.strip(), new_filler.strip())

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
