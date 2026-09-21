import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

old_code = """
        } else {
          const tier = zoneOf(c).tier;
          const validTiles = library.tiles.filter(t => !t.eligibleTiers || t.eligibleTiers.includes(tier));
          const domain: TileOption[] = [];
          for (const t of validTiles) {
            const diff = getDifficulty(t);
            const orients = t.orientations && t.orientations.length ? t.orientations : [0];
            for (const o of orients) {
              domain.push({ templateId: t.id, orientation: o as any, difficulty: diff, weight: t.weight || 1 });
            }
          }
          return { x: c.x, y: c.y, domain };
        }
"""

new_code = """
        } else {
          const tier = zoneOf(c).tier;
          const validTiles = library.tiles.filter(t => !t.eligibleTiers || t.eligibleTiers.includes(tier));
          const domain: TileOption[] = [];
          
          for (const t of validTiles) {
            // Find the shared TileOption objects from the `tiles` array!
            for (const tOpt of tiles) {
              if (tOpt.templateId === t.id) domain.push(tOpt);
            }
          }
          return { x: c.x, y: c.y, domain };
        }
"""
core = core.replace(old_code.strip(), new_code.strip())

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
