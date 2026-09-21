import re

with open("src/core.ts", "r", encoding="utf-8") as f:
    core = f.read()

old_code = """
        if (assigned[i]) {
          return {
            x: c.x, y: c.y,
            domain: [{
              weight: 1,
              templateId: assigned[i]!.templateId,
              orientation: assigned[i]!.orientation as any,
              difficulty: 0
            }]
          }
"""

new_code = """
        if (assigned[i]) {
          const a = assigned[i]!;
          const match = tiles.find(t => t.templateId === a.templateId && t.orientation === a.orientation);
          // If we can't find it in tiles (shouldn't happen), create inline, but it might lack precalc.
          return {
            x: c.x, y: c.y,
            domain: match ? [match] : [{
              weight: 1,
              templateId: a.templateId,
              orientation: a.orientation as any,
              difficulty: 0
            }]
          }
"""
core = core.replace(old_code.strip(), new_code.strip())

with open("src/core.ts", "w", encoding="utf-8") as f:
    f.write(core)
